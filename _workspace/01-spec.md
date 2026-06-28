# Spec: MITM Handler cho Windsurf/Devin CLI (account rotation qua 9router /v1)

> Feature ID: `mitm-windsurf-devin-cli`
> Ngày: 2026-06-28
> Tác giả: router-architect (spec phase)
> Trạng thái: draft — chờ user confirm Phase 1 (cert pinning verify) trước khi implement Phase 2/3

## Mục tiêu (Executive Summary)

Cho phép **Devin CLI** (Rust binary của Cognition, gọi Connect-RPC tới `server.codeium.com`) đi qua 9router để tận dụng cơ chế **account rotation** đã sẵn có ở `/v1` (`WindsurfExecutor`).

Cách tiếp cận: dùng **MITM mode** sẵn có của 9router — DNS redirect `server.codeium.com` → `127.0.0.1`, forge TLS cert bằng root CA tự ký, intercept Connect-RPC, decode protobuf request → translate sang Anthropic messages → forward tới 9router `/v1/messages` (nơi rotate account) → re-encode response OpenAI/Anthropic SSE thành Connect-RPC protobuf frames → stream về Devin CLI.

**KHÔNG sửa gì ở Devin CLI.** Không cần `proxy` config, không cần env var, không cần base URL override.

## Neo vào tiền lệ (Reference)

Feature này mô phỏng **MITM handler cho Kiro** — tiền lệ gần nhất đã tồn tại:

- Handler: <ref_file file="/Users/luisphan/Documents/9router/src/mitm/handlers/kiro.js" />
- Server wire-up: <ref_snippet file="/Users/luisphan/Documents/9router/src/mitm/server.js" lines="37-42" />
- Config: <ref_snippet file="/Users/luisphan/Documents/9router/src/mitm/config.js" lines="16-29" />
- Handler contract: `intercept(req, res, bodyBuffer, mappedModel)` → `fetchRouter(openaiBody, "/v1/chat/completions", req.headers)` → pipe/encode về client
- Tool host map: <ref_snippet file="/Users/luisphan/Documents/9router/src/shared/constants/mitmToolHosts.js" lines="5-10" />

Khác biệt quan trọng với Kiro:

| Khía cạnh | Kiro | Windsurf/Devin (feature này) |
|---|---|---|
| Protocol wire | AWS EventStream + JSON | Connect-RPC + protobuf (frame `[0x00][4-byte BE len][payload]`) |
| 9router endpoint đích | `/v1/chat/completions` (OpenAI) | `/v1/messages` (Anthropic) — vì `WindsurfExecutor` đã đăng ký với `format: "claude"` |
| Building block đã có | CodeWhisperer→OpenAI translator | `windsurfProtobuf.js` đã có `buildGetChatMessageRequest` + `decodeGetChatMessageResponse` (dùng cho chiều outbound 9router→Windsurf) — **cần viết inverse functions** cho chiều inbound Devin→9router |
| Account rotation | Via Kiro executor | Via `WindsurfExecutor` đã có — chọn connection trong DB, có sẵn retry/fallback |

## Rủi ro lớn nhất cần loại trước khi implement (BLOCKER)

**Cert pinning của Devin CLI.** Devin CLI là Rust binary dùng rustls. Nếu `server.codeium.com` bị pin cert thì MITM không thể forge cert → toàn bộ approach chết. **Bắt buộc verify ở Phase 1 trước khi đầu tư Phase 2.**

Cách verify (xem implementation plan dưới): sửa tạm `TOOL_HOSTS` + `getToolForHost`, tạo handler passthrough tạm (chỉ forward về IP thật của `server.codeium.com`, không translate), install root CA 9router vào Keychain, chạy `devin auth login` + 1 prompt đơn giản. Nếu TLS handshake OK → đi tiếp. Nếu TLS error dạng `CertificateNotTrusted`/`UnknownIssuer` → có thể fix bằng install CA; nếu error dạng pinning/cert mismatch ngay cả khi CA đã trust → **dừng, không implement tiếp**.

## Provider/executor

- **Cần provider mới?** **No.** `WindsurfExecutor` đã tồn tại ở `open-sse/executors/windsurf.js`, đã đăng ký (xem <ref_file file="/Users/luisphan/Documents/9router/open-sse/executors/windsurf.js" /> và `PROVIDERS.windsurf` trong `open-sse/config/providers.js`).
- **Cần sửa executor?** No. Logic rotation trong `WindsurfExecutor.getApiKey()` đã đọc credentials từ DB → 9router `/v1` đã tự rotate khi nhận request từ MITM handler.
- **Cần đăng ký executor?** No.

## Core handler / MITM module (src/mitm/)

Đây là **fat core** của feature — feature này sống ở MITM module, KHÔNG phải `src/sse/handlers/` (vì 9router `/v1` đã có sẵn WindsurfExecutor).

### 1. File mới: `src/mitm/handlers/windsurf.js`

| Mặt | Đặc tả |
|---|---|
| Export | `intercept(req, res, bodyBuffer, mappedModel)` — cùng signature với `kiro.js`/`cursor.js` |
| Input | `bodyBuffer`: raw body từ Devin CLI = 1+ Connect-RPC frames `[0x00][4-byte BE len][protobuf payload]`. `mappedModel`: alias đã resolve từ `getMitmAlias("windsurf")` |
| Output | Stream Connect-RPC frames về `res`. Frame flag `0x00` = data, `0x02` = end (JSON error nếu có). Content-Type `application/connect+proto`. Headers `Connect-Protocol-Version: 1`, `TE: trailers` |

#### Pipeline trong `intercept()`:

1. **Split Connect-RPC frames** từ `bodyBuffer` — re-use `connectFrameDecode(chunk)` đã có trong `windsurfProtobuf.js` (cần export ra, hiện đã export). **Caveat:** `connectFrameDecode` dùng module-level `frameBuffer` (stateful, không reentrant). Cần refactor thành pure function `splitConnectFrames(buffer)` nhận buffer tường minh, hoặc tạo instance per-request. **Quyết định:** refactor thành pure function `splitConnectFrames(buffer)` — không phá existing caller (outbound direction) vì outbound đi qua fetch stream riêng.
2. **Decode protobuf request** từ frame đầu tiên (flag `0x00`): gọi hàm mới `decodeGetChatMessageRequest(payload) → { metadata, system, messages[], tools[], configuration, modelUid }` (xem section "Protobuf inverse functions" dưới).
3. **Translate sang Anthropic request** (làm ngược `WindsurfExecutor` outbound):
   - `messages[]` (Windsurf `ChatMessagePrompt`) → Anthropic `messages[]` (map `source` ngược: `USER→user`, `SYSTEM→assistant`, `TOOL→tool`, `SYSTEM_PROMPT→system` tách ra top-level)
   - `tools[]` (Windsurf `ChatToolDefinition`) → Anthropic `tools[]` (`name`, `description`, `input_schema = JSON.parse(inputSchemaStr)`)
   - `configuration.max_newlines*400` ≈ `max_tokens` (giới hạn an toàn)
   - `modelUid` → chọn alias hoặc để 9router tự chọn nếu `mappedModel` đã có
   - **Strip `metadata`** (chứa `windsurf_api_key` của user) — 9router sẽ inject credential rotate từ DB
4. **Forward tới 9router**: `fetchRouter(anthropicBody, "/v1/messages", req.headers)` (qua `handlers/base.js`). 9router sẽ route tới `WindsurfExecutor` (vì path `/v1/messages` + `format: "claude"`), rotate account, gọi thật tới `server.codeium.com`, trả về **Anthropic SSE**.
5. **Re-encode Anthropic SSE → Connect-RPC protobuf frames**:
   - Parse từng SSE event (`event: content_block_delta` / `content_block_start` / `message_delta` / `message_stop` / …)
   - Mỗi text delta → 1 frame `[0x00][len][buildGetChatMessageResponse({delta_text})]`
   - Mỗi tool_use delta → 1 frame chứa `delta_tool_calls` (field 6, repeated)
   - Mỗi thinking delta → 1 frame chứa `delta_thinking` (field 9)
   - `message_stop` → 1 frame chứa `stop_reason` (field 5) + `usage` (field 7) + cuối cùng 1 end frame `[0x02][0]` (empty payload = success) hoặc `[0x02][json error]` nếu có error
   - Cần viết hàm mới `buildGetChatMessageResponse(delta)` — inverse của `decodeGetChatMessageResponse` đã có
6. **Error handling**: nếu 9router trả error SSE (`event: error`), re-encode thành Connect-RPC end frame `[0x02][{error:{code, message}}]` dùng `mapConnectErrorToAnthropic` ngược lại (Anthropic type → Connect code).

#### Logic boundary cho contract test:

- **Hàm testable cô lập:** `decodeGetChatMessageRequest(payload) → { messages, tools, system, modelUid, ... }` (pure function, không dính I/O)
- **Hàm testable cô lập:** `buildGetChatMessageResponse(delta) → Buffer` (pure function, inverse của `decodeGetChatMessageResponse`)
- **Hàm testable cô lập:** `anthropicSseToConnectFrames(sseEvent) → Buffer[]` (chuyển 1 SSE event → 0..N Connect frames)
- **Lý do chọn:** `intercept()` dính `req`/`res`/`fetch` (I/O nặng), khó mock sạch. 3 hàm decode/encode/translate trên là pure → mirror pattern test của `windsurf-executor.test.js` (mock `proxyFetch`, test pure translators).
- **KHÔNG chọn** `intercept()` làm boundary — phải mock cả `req`, `res`, `fetchRouter`, Connect frame splitting → test bị noise.

### 2. Sửa `src/mitm/config.js`

```diff
 const TARGET_HOSTS = [
   "daily-cloudcode-pa.googleapis.com",
   "cloudcode-pa.googleapis.com",
   "api.individual.githubcopilot.com",
   "q.us-east-1.amazonaws.com",
   "api2.cursor.sh",
+  "server.codeium.com",
 ];

 const URL_PATTERNS = {
   antigravity: [":generateContent", ":streamGenerateContent"],
   copilot: ["/chat/completions", "/v1/messages", "/responses"],
   kiro: ["/generateAssistantResponse"],
   cursor: ["/BidiAppend", "/RunSSE", "/RunPoll", "/Run"],
+  windsurf: ["/exa.api_server_pb.ApiServerService/GetChatMessage"],
 };

 function getToolForHost(host) {
   const h = (host || "").split(":")[0];
   if (h === "api.individual.githubcopilot.com") return "copilot";
   if (h === "daily-cloudcode-pa.googleapis.com" || h === "cloudcode-pa.googleapis.com") return "antigravity";
   if (h === "q.us-east-1.amazonaws.com") return "kiro";
   if (h === "api2.cursor.sh") return "cursor";
+  if (h === "server.codeium.com") return "windsurf";
   return null;
 }
```

Lưu ý `extractModel()` trong `server.js` hiện parse JSON body — với Windsurf body là protobuf, **JSON.parse sẽ throw**. Cần guard: nếu `tool === "windsurf"` thì bỏ qua `extractModel()` và delegate thẳng cho handler (giống special case `cursor` đã làm ở <ref_snippet file="/Users/luisphan/Documents/9router/src/mitm/server.js" lines="342-344" />).

### 3. Sửa `src/mitm/server.js`

```diff
 const handlers = {
   antigravity: require("./handlers/antigravity"),
   copilot: require("./handlers/copilot"),
   kiro: require("./handlers/kiro"),
   cursor: require("./handlers/cursor"),
+  windsurf: require("./handlers/windsurf"),
 };
```

Và trong request handler, thêm special case delegation (cùng pattern với cursor):

```diff
     // Cursor uses binary proto — model extraction not possible at this layer.
     // Delegate directly to handler which decodes proto internally.
-    if (tool === "cursor") {
+    if (tool === "cursor" || tool === "windsurf") {
       return handlers[tool].intercept(req, res, bodyBuffer, null, passthrough);
     }
```

`mappedModel` truyền `null` — handler sẽ tự extract `modelUid` từ protobuf field 21 (`chat_model_uid`) của request, hoặc dùng alias default từ `getMitmAlias("windsurf")`.

### 4. Sửa `src/shared/constants/mitmToolHosts.js`

```diff
 const TOOL_HOSTS = {
   antigravity: ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"],
   copilot: ["api.individual.githubcopilot.com"],
   kiro: ["q.us-east-1.amazonaws.com", "codewhisperer.us-east-1.amazonaws.com"],
   cursor: ["api2.cursor.sh"],
+  windsurf: ["server.codeium.com"],
 };
```

### 5. Protobuf inverse functions — mở rộng `open-sse/utils/windsurfProtobuf.js`

Thêm 3 export mới (pure functions, không I/O):

#### `decodeGetChatMessageRequest(payload: Uint8Array) → object`

Inverse của `buildGetChatMessageRequest`. Dùng `decodeMessage` đã có. Trả:

```js
{
  metadata: { ideName, extensionVersion, apiKey, locale, os, ideVersion, extensionName },  // field 1
  system: string,                                                                           // field 2
  messages: [ { messageId, source, prompt, toolCallId?, toolCalls?, thinking? } ],          // field 3 (repeated)
  requestType: number,                                                                       // field 7
  configuration: { numCompletions, maxTokens, maxNewlines, temperature, topK, topP },       // field 8
  tools: [ { name, description, inputSchemaStr } ],                                          // field 10 (repeated)
  cascadeId: string,                                                                         // field 16
  plannerMode: number,                                                                       // field 20
  modelUid: string,                                                                          // field 21
  executionId: string                                                                        // field 22
}
```

Sub-decoders cần thêm: `decodeMetadata`, `decodeChatMessagePrompt`, `decodeToolDefinition`, `decodeConfiguration`. Tất cả dùng `decodeMessage` + `decodeVarint` đã có.

#### `buildGetChatMessageResponse(delta: object) → Uint8Array`

Inverse của `decodeGetChatMessageResponse`. Nhận delta shape:

```js
{
  delta_text?: string,         // → field 3
  stop_reason?: number,        // → field 5
  delta_tool_calls?: [...],    // → field 6 (repeated, mỗi item build bằng `buildToolCall` đã có)
  usage?: {...},               // → field 7 (cần thêm `buildUsage`)
  delta_thinking?: string      // → field 9
}
```

#### `buildConnectFrame(flags: 0x00|0x02, payload: Uint8Array) → Buffer`

Wrap payload với Connect-RPC framing `[flags][4-byte BE length][payload]`. Hiện logic này nằm inline trong `WindsurfExecutor.execute()` (outbound) — extract thành helper共用. **Caveat:** `WindsurfExecutor.buildConnectFrame()` hiện dùng `Buffer.concat([Buffer.from([0x00]), lengthBytes, payload])` hardcode flag `0x00` — cần parametrize flag để tái use cho end frame `0x02`.

#### `splitConnectFrames(buffer: Buffer) → Array<{flags, payload}>`

Pure version của `connectFrameDecode` (không dùng module-level `frameBuffer`). Refactor existing `connectFrameDecode` để gọi `splitConnectFrames` internal — giữ backward compat cho outbound caller.

### 6. Dashboard UI + manager.js — thêm toggle "Windsurf/Devin"

- File UI: `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` (xem <ref_snippet file="/Users/luisphan/Documents/9router/src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js" lines="1540-1540" /> — hiện có Cloudflare tunnel disconnect UI)
- Tìm component list tool toggle (Antigravity/Copilot/Kiro/Cursor) và thêm "Windsurf/Devin CLI"
- `manager.js` đã có `saveDnsToolState(tool, enabled)` + `restoreToolDNS(sudoPassword)` (<ref_snippet file="/Users/luisphan/Documents/9router/src/mitm/manager.js" lines="295-330" />) — generic theo `TOOL_HOSTS`, không cần sửa code logic, chỉ cần UI expose thêm tool
- **Cờ rủi ro UI:** cần check có hardcode list `[antigravity, copilot, kiro, cursor]` ở UI không — nếu có phải thêm `windsurf`

## Route (src/app/api/...)

- **Không có route /v1 mới.** 9router `/v1/messages` đã tồn tại và đã wire tới `WindsurfExecutor`.
- **Không có `force-dynamic` mới.**
- Request shape → Response shape: giữ nguyên `/v1/messages` Anthropic SSE → không thay đổi.

## Contract test (tests/unit/)

### File mới: `tests/unit/windsurf-mitm-contract.test.js`

Phủ các assertion sau (mirror chiến lược mock của <ref_file file="/Users/luisphan/Documents/9router/tests/unit/windsurf-executor.test.js" />):

1. **`splitConnectFrames(buffer)`** — roundtrip:
   - Input: 2 frames ghép `[0x00][len1][payload1][0x00][len2][payload2]`
   - Assert: trả đúng 2 item `{flags:0, payload:payload1}`, `{flags:0, payload:payload2}`
   - Edge: buffer cắt giữa frame (incomplete) → trả mảng rỗng hoặc partial (theo design pure version)
2. **`decodeGetChatMessageRequest(payload)`** — roundtrip với `buildGetChatMessageRequest`:
   - Build request từ Anthropic input mẫu → decode lại → assert các field khớp (messages, tools, system, modelUid, configuration)
   - Edge: request không có tools / không có system → decode vẫn không crash, trả `[]` / `""`
3. **`buildGetChatMessageResponse(delta)`** — roundtrip với `decodeGetChatMessageResponse`:
   - Build `{delta_text: "hello"}` → decode lại → assert `delta_text === "hello"`
   - Build `{delta_tool_calls: [{id, name, arguments_json}]}` → decode → assert toolCalls khớp
   - Build `{stop_reason: 1, usage: {input_tokens: 10, output_tokens: 5}}` → decode → assert khớp
4. **`buildConnectFrame(0x00, payload)`** — assert frame format `[0x00][4-byte BE len][payload]`
5. **`buildConnectFrame(0x02, errorJson)`** — assert end frame format `[0x02][len][json bytes]`
6. **`anthropicSseToConnectFrames(sseEvent)`** — test các case SSE event:
   - `event: content_block_delta\ndata: {"delta":{"text":"hi"}}` → 1 data frame chứa `delta_text: "hi"`
   - `event: message_stop\ndata: {}` → 1 data frame chứa `stop_reason` + 1 end frame `0x02` empty
   - `event: error\ndata: {"error":{"type":"rate_limit_error"}}` → 1 end frame `0x02` chứa JSON error

Feature tham chiếu để mirror mock: <ref_file file="/Users/luisphan/Documents/9router/tests/unit/windsurf-executor.test.js" /> (mock `proxyFetch`, test pure translators) và <ref_file file="/Users/luisphan/Documents/9router/tests/unit/windsurfCore-contract.test.js" />.

### File mới (optional Phase 1): `tests/unit/windsurf-mitm-passthrough.test.js`

Phase 1 verify cert pinning có thể không cần test tự động (manual test với Devin CLI thật). Nếu muốn coverage: test `passthrough()` với `tool === "windsurf"` không translate, chỉ forward — nhưng passthrough đã test qua các tool khác, low value. **Bỏ qua nếu Phase 1 manual là đủ.**

## Phân công implement (cho team)

> Lưu ý: feature này **không có route-implementer role** vì không động vào `/v1` route. Phân công điều chỉnh so với template mặc định.

### core-implementer (phần lớn work)

1. Refactor `connectFrameDecode` → extract `splitConnectFrames(buffer)` pure function trong `open-sse/utils/windsurfProtobuf.js` (giữ backward compat)
2. Viết `decodeGetChatMessageRequest(payload)` + 4 sub-decoder (`decodeMetadata`, `decodeChatMessagePrompt`, `decodeToolDefinition`, `decodeConfiguration`) trong cùng file
3. Viết `buildGetChatMessageResponse(delta)` + `buildUsage(usage)` trong cùng file
4. Parametrize `WindsurfExecutor.buildConnectFrame()` thành `buildConnectFrame(flags, payload)` export pure (không phá existing caller outbound — default flag `0x00` nếu muốn bảo toàn)
5. Viết `anthropicSseToConnectFrames(sseEvent)` helper (có thể đặt trong handler file hoặc utils — quyết định lúc implement, ưu tiên utils để testable)
6. Viết `src/mitm/handlers/windsurf.js` — function `intercept()` dùng các helper trên, gọi `fetchRouter(body, "/v1/messages", req.headers)`, stream frames về `res`
7. Sửa `src/mitm/config.js` (thêm host, URL pattern, `getToolForHost` case)
8. Sửa `src/mitm/server.js` (register handler + special case delegation như cursor)
9. Sửa `src/shared/constants/mitmToolHosts.js` (thêm `windsurf: ["server.codeium.com"]`)

### route-implementer

**No work.** `/v1/messages` đã tồn tại, đã wire tới `WindsurfExecutor`. Không thêm route.

### contract-tester

1. Viết `tests/unit/windsurf-mitm-contract.test.js` với 6 group assertion ở trên
2. Mirror mock strategy từ `windsurf-executor.test.js` (`vi.mock` cho `proxyFetch`, test pure translators)
3. Chạy `cd tests && npm test -- unit/windsurf-mitm-contract.test.js` — phải green trước khi handoff

### boundary-qa (sau khi core+test xong)

1. So khớp shape: `intercept()` signature khớp với caller ở `server.js` (`handlers[tool].intercept(req, res, bodyBuffer, null, passthrough)`)
2. So khớp `fetchRouter` call: path `"/v1/messages"` phải khớp với route tồn tại ở `src/app/api/v1/messages/route.js`
3. Verify `TOOL_HOSTS.windsurf` + `URL_PATTERNS.windsurf` + `getToolForHost("server.codeium.com")` đều consistent
4. Verify dashboard UI expose toggle Windsurf (nếu UI hardcode list tool)

### deploy-gate (cuối)

1. `code-review-graph` `detect_changes` + `get_impact_radius` cho diff
2. Check `force-dynamic` — không cần (feature không động route)
3. Env Dokploy: không cần env mới (MITM đã có `MITM_ROUTER_BASE`, `ROUTER_API_KEY` — tái use)
4. Risk: cert pinning chưa verify → **BLOCK deploy production cho tới khi Phase 1 manual verify pass**

## Implementation plan (3 phase)

### Phase 1 — Verify cert pinning (BẮT BUỘC làm trước, ~1-2 giờ, manual)

Mục tiêu: loại risk lớn nhất trước khi đầu tư Phase 2.

1. Sửa tạm `TOOL_HOSTS` + `getToolForHost` + `URL_PATTERNS` (3 file config) — chưa cần handler
2. Tạo `src/mitm/handlers/windsurf.js` tạm chỉ gọi `passthrough(req, res, bodyBuffer)` (forward về IP thật của `server.codeium.com` qua `resolveTargetIP`, không translate)
3. Register handler tạm trong `server.js`
4. User bật MITM mode trong dashboard, enable tool "Windsurf/Devin", install root CA 9router vào macOS Keychain (thường 9router auto-prompt)
5. User chạy `devin auth login` + 1 prompt đơn giản trong Devin CLI
6. **Kết quả:**
   - ✅ TLS handshake OK, Devin CLI hoạt động bình thường → không pin cert, đi tiếp Phase 2
   - ❌ TLS error `CertificateNotTrusted`/`UnknownIssuer` ngay cả khi CA đã trust → có cert pinning, **DỪNG**, không làm Phase 2
   - ⚠️ Error khác (network, auth) → debug riêng

### Phase 2 — Build full handler (work chính, ~1-3 ngày)

1. Implement protobuf inverse functions (core-implementer step 1-5)
2. Implement `intercept()` đầy đủ (core-implementer step 6)
3. Viết contract test song song (contract-tester)
4. Boundary-qa check shape

### Phase 3 — Wire up UI + polish (~0.5 ngày)

1. Thêm toggle "Windsurf/Devin" trong dashboard UI (nếu chưa tự generic từ `TOOL_HOSTS`)
2. Deploy-gate precheck
3. Test end-to-end: bật MITM + tool Windsurf → chạy Devin CLI prompt phức tạp (multi-turn, tool calls) → verify response đúng, verify 9router dashboard log usage theo account rotate

## Cờ rủi ro (Risk flags)

| Cờ | Mức | Ghi chú |
|---|---|---|
| **Cert pinning chưa verify** | 🔴 HIGH (blocker) | Chưa biết Devin CLI có pin cert cho `server.codeium.com` không. Phase 1 phải pass trước Phase 2 |
| **Protocol translation 2 chiều** | 🟡 MEDIUM | Phải viết inverse functions chính xác cho protobuf schema đã biết. Schema có sẵn (outbound direction đã build), nhưng inverse decode request + build response là code mới — test roundtrip là bắt buộc |
| **`connectFrameDecode` stateful** | 🟡 MEDIUM | Hiện dùng module-level `frameBuffer` — không reentrant cho concurrent requests. Refactor thành pure `splitConnectFrames` là bắt buộc, không thể dùng trực tiếp |
| **Content policy workaround** | 🟡 LOW | `WindsurfExecutor` đã strip system-reminder + nuclear tool descriptions ở outbound direction. Khi Devin CLI inbound qua MITM, request đi tới 9router `/v1` rồi mới ra `WindsurfExecutor` — các strip này vẫn áp dụng (vì executor vẫn chạy), nên không cần strip thêm ở MITM layer |
| **ToS violation risk** | 🟡 NON-TECHNICAL | Rotate nhiều tài khoản Windsurf để vượt quota limit gần như chắc chắn vi phạm ToS Cognition/Windsurf. Risk: khóa toàn bộ account, mất quyền truy cập Devin Enterprise, có thể phát sinh vấn đề pháp lý với contract enterprise. **Đã thông báo cho user 1 lần; quyết định kỹ thuật là của user** |
| **Devin CLI cert store** | 🟢 LOW | rustls dùng OS cert store trên macOS (Keychain). 9router MITM đã có flow install root CA vào Keychain — đã work cho 4 tool khác |
| **HTTP/2 vs HTTP/1.1** | 🟢 LOW | `server.js` `passthrough()` đã ALPN negotiate. Windsurf endpoint `server.codeium.com` cần check — nếu HTTP/2, `passthroughHttp2` đã có; nếu HTTP/1.1, `passthroughHttps` đã có. Không cần code mới |
| **Session-dependent route** | 🟢 NONE | Không động route /v1, không cần `force-dynamic` |

## Tóm tắt để bàn giao

- **Spec file:** `_workspace/01-spec.md` (file này)
- **Boundary chọn để test:** 3 pure function `decodeGetChatMessageRequest` / `buildGetChatMessageResponse` / `anthropicSseToConnectFrames` — tránh phải mock I/O của `intercept()`
- **Đặc thù so với template mặc định:** feature động MITM module, KHÔNG động route /v1 → role `route-implementer` không có việc
- **BLOCKER trước khi implement Phase 2:** Phase 1 verify cert pinning phải pass
- **Tiền lệ mirror:** `kiro.js` (handler MITM) + `windsurf-executor.test.js` (test pattern)
