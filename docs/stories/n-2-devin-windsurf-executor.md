---
id: N.2
title: Devin Executor (REST v3) + Windsurf Executor (Cascade WS)
epic: N
status: ready-for-dev
priority: high
storyPoints: 8
baseline_commit: b55a2082
context:
  - _bmad-output/planning-artifacts/epics.md
  - _workspace/01-spec-n2.md
  - docs/stories/n-1-devin-provider-config-auth-models.md
  - open-sse/config/providers.js
  - open-sse/config/providerModels.js
  - open-sse/executors/base.js
  - open-sse/executors/index.js
  - open-sse/executors/codex.js
  - src/shared/constants/providers.js
  - src/app/api/v1/models/route.js
  - src/app/api/providers/validate/route.js
  - src/app/api/providers/[id]/test/testUtils.js
  - /Users/luisphan/Documents/fast-context-mcp/deepgrep/src/core.mjs
  - /Users/luisphan/Documents/fast-context-mcp/deepgrep/src/protobuf.mjs
  - /Users/luisphan/Documents/fast-context-mcp/deepgrep/src/extract-key.mjs
---

# Story N.2: Devin Executor (REST v3) + Windsurf Executor (Cascade WS)

Status: ready-for-dev

## Story

As a **developer tích hợp 9router**,
I want **gọi `devin/normal|fast|lite|ultra` (agent session REST v3) và `windsurf/swe` (LLM chat free tier Cascade WS) qua `POST /v1/chat/completions`**,
so that **agent khác (Claude, GPT, custom bot) có thể dùng Devin agent + Windsurf LLM qua 1 endpoint OpenAI-compatible thống nhất**.

## Bối cảnh và quyết định architecture

> **Story này add 2 executor + 1 provider mới (windsurf).** N.1 đã khai báo provider `devin` (4 model tĩnh + validate + env shortcut). N.2 add executor cho `devin` (REST v3 wrap) VÀ add provider `windsurf` hoàn chỉnh (registry + executor Cascade WS + env shortcut). Sau N.2: `POST /v1/chat/completions {model:"devin/normal"}` và `{model:"windsurf/swe"}` chạy được.

### Research findings — verified 2026-06-25 với real API

- **REST v3 Devin verified với cog_* thật + orgId thật:**
  - `GET /v3/organizations/{org_id}/sessions` → HTTP 200, response `{items:[],end_cursor:null,has_next_page:false,total:0}`. Validate logic N.1 đã work.
  - `POST /v3/organizations/{org_id}/sessions {prompt,devin_mode}` → 403 `out_of_quota` cho `normal`/`fast`/`ultra` (mode available, org hết quota billing), 400 `devin_mode 'lite' is not available for this organization` (mode không có ở tier này).
  - → N.2 executor REST v3 endpoint + auth + request shape đều verified. Quota là vấn đề billing của org, không phải code.
- **Cascade WS Windsurf verified qua deepgrep (đang chạy):**
  - `AUTH_BASE = "https://server.self-serve.windsurf.com/exa.auth_pb.AuthService"` → `GetUserJwt` trả JWT từ windsurf session token.
  - `API_BASE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService"` → `GetDevstralStream` trả protobuf stream.
  - Auth: `devin-session-token$eyJ...` (extract từ `state.vscdb` qua `extract-key.mjs`, field `windsurfAuthStatus.apiKey`).
  - Model: `MODEL_SWE_1_6_SLOW` (env `WS_MODEL` override).
  - Free tier, không cần quota.
- **2 hệ thống KHÁC NHAU, không fallback silently:** REST v3 = agent session (phút-giờ, structured output, ACU quota). Cascade WS = LLM chat (giây, streaming tokens, free). Output format + thời gian + use case khác hoàn toàn → 2 executor riêng, surface error thật.

### Kiến trúc hiện tại (neo vào tiền lệ)

1. **`open-sse/executors/base.js`** → `BaseExecutor` với `execute({model, body, stream, credentials, signal, log, proxyOptions})` trả `{response, url, headers, transformedBody}`. `buildUrl`/`buildHeaders`/`transformRequest`/`shouldRetry` override được. [Source: open-sse/executors/base.js:109-184]
2. **`open-sse/executors/index.js`** → registry `executors = {antigravity, azure, gemini-cli, github, iflow, qoder, kiro, codex, cursor, vertex, qwen, opencode, opencode-go, grok-web, perplexity-web, ollama-local, commandcode}`. `getExecutor(provider)` fallback `DefaultExecutor`. `hasSpecializedExecutor(provider)` check. [Source: open-sse/executors/index.js:1-40]
3. **`open-sse/config/providers.js`** → `PROVIDERS` object, mỗi provider `{baseUrl, format, headers}`. N.1 đã add `devin: {baseUrl:"https://api.devin.ai/v3/organizations", format:"devin"}`. [Source: open-sse/config/providers.js]
4. **`open-sse/config/providerModels.js`** → `PROVIDER_MODELS` object. N.1 đã add `devin: [normal, fast, lite, ultra]`. [Source: open-sse/config/providerModels.js]
5. **`src/shared/constants/providers.js`** → `APIKEY_PROVIDERS` group. N.1 đã add `devin` với `hasProviderSpecificData: true` (orgId). [Source: src/shared/constants/providers.js]
6. **`src/app/api/v1/models/route.js`** → `buildModelsList()`. N.1 đã add `DEVIN_API_KEY`+`DEVIN_ORG_ID` env shortcut (synthetic connection). [Source: src/app/api/v1/models/route.js]
7. **`src/app/api/providers/validate/route.js`** → `POST` handler với `if (provider === "devin")` block (N.1). [Source: src/app/api/providers/validate/route.js:200-220]
8. **`src/app/api/providers/[id]/test/testUtils.js`** → `case "devin":` (N.1). [Source: src/app/api/providers/[id]/test/testUtils.js]
9. **Pattern poll/async:** Các executor hiện tại (codex/kiro/cursor/qoder) đều true-stream hoặc unwrap envelope, KHÔNG có poll-to-finished. DevinExecutor phải implement poll loop mới + timeout + abort — **pattern mới, risk HIGH**.
10. **Pattern protobuf WS:** Không có executor nào dùng protobuf. WindsurfExecutor phải port từ `deepgrep/src/core.mjs` + `protobuf.mjs` — **pattern mới, risk HIGH**.

### Quyết định

- **QĐ1 — 2 executor riêng, 2 provider riêng.** `DevinExecutor` (provider `devin`, N.1 đã có registry) + `WindsurfExecutor` (provider `windsurf`, NEW registry). Lý do: 2 protocol/auth/output khác hoàn toàn, không thể gộp, không fallback silently.
- **QĐ2 — `windsurf` là provider mới.** Add vào 3 registry (giống N.1 pattern): `PROVIDERS` (open-sse/config/providers.js), `PROVIDER_MODELS` (1 model `swe`), `APIKEY_PROVIDERS` (src/shared/constants/providers.js). `format: "windsurf"` (custom). `hasProviderSpecificData: false` (env-only, không có orgId field).
- **QĐ3 — DevinExecutor: REST v3 wrap.** `POST /v3/organizations/{org_id}/sessions {prompt, devin_mode}` → poll `GET .../sessions/{id}` mỗi `DEVIN_POLL_INTERVAL_MS` (default 2000ms, env override) tới `status_enum=finished` (timeout 30ph default, env `DEVIN_SESSION_TIMEOUT_MS` override) → extract `output` → emit OpenAI SSE (1 chunk nguyên output + `finish_reason=stop`). 403 `out_of_quota` → surface error, KHÔNG fallback. 404 org → surface error. 5xx → surface error.
- **QĐ4 — WindsurfExecutor: port protobuf từ deepgrep.** Port `ProtobufEncoder`, `connectFrameEncode`, `connectFrameDecode`, `extractStrings`, `decodeVarint` từ `deepgrep/src/protobuf.mjs` vào `open-sse/utils/windsurfProtobuf.js`. Port `fetchJwt`, `getCachedJwt`, `_getJwtExp`, `checkRateLimit`, `_buildMetadata`, `_buildRequest`, `_streamingRequest`, `_unaryRequest` từ `deepgrep/src/core.mjs` vào `open-sse/utils/windsurfAuth.js` + `windsurfExecutor.js`. Parse protobuf response → extract text delta → re-wrap thành OpenAI SSE. True streaming.
- **QĐ5 — Windsurf auth: env `WINDSURF_API_KEY` hoặc auto-extract.** Env shortcut `WINDSURF_API_KEY` (token `devin-session-token$...`). Auto-extract từ `state.vscdb` qua port `extract-key.mjs` sang `open-sse/utils/windsurfAuth.js` nếu env không set. KHÔNG lưu DB connection cho windsurf ở N.2 (env-only, defer UI connection sang story sau).
- **QĐ6 — Polling là pattern mới.** DevinExecutor implement poll loop: `while (status !== finished && !timeout && !signal.aborted) { await sleep(DEVIN_POLL_INTERVAL_MS); fetch status }`. Timeout 30ph default + env `DEVIN_SESSION_TIMEOUT_MS` override. Poll interval `DEVIN_POLL_INTERVAL_MS` default 2000ms + env override. Abort-safe: check `signal.aborted` trước mỗi iteration, `clearTimeout` khi done.
- **QĐ7 — Model `windsurf/swe` mapping.** `PROVIDER_MODELS["windsurf"] = [{id:"swe", upstreamId:"MODEL_SWE_1_6_SLOW", name:"Windsurf SWE LLM (free tier, code search)"}]`. Upstream model = `MODEL_SWE_1_6_SLOW` (env `WS_MODEL` override, mirror deepgrep).
- **QĐ8 — KHÔNG sửa N.1 artifact.** Không đụng `devin` registry đã chốt. Không sửa validate/testUtils case `devin` (chỉ ADD case `windsurf`). Không sửa devin env shortcut.
- **QĐ9 — Devin output: 1 chunk nguyên output.** Emit nguyên `output` field làm 1 chunk `delta.content` + `finish_reason=stop` + `data: [DONE]`. Đơn giản, agent nhận 1 message lớn. Không true stream (REST v3 không support).
- **QĐ10 — Implement theo 2 phase.** Phase 1: Windsurf (test được ngay với real API free tier). Phase 2: Devin (mock test, real API cần topup quota).
- **QĐ11 — Executor return contract (F1 fix).** Cả 2 executor override `execute()` hoàn toàn, **KHÔNG gọi `super.execute()`** (F5 fix). Trả về `{response, url, headers, transformedBody}` trong đó `response` là **synthetic `new Response(body, {status, headers})`** với body đã là **OpenAI format**:
  - `stream: true` → `body` là `ReadableStream` emit OpenAI SSE chunks (`data: {choices:[{delta:{content}}]}` + `data: [DONE]`), header `Content-Type: text/event-stream`.
  - `stream: false` → `body` là JSON string `{choices:[{message:{content}, finish_reason:"stop"}], usage:{...}}`, header `Content-Type: application/json`.
  - `url` = upstream URL cuối cùng gọi (cho log), `headers` = headers gửi upstream (cho log), `transformedBody` = body gửi upstream (cho log).
  - **chatCore.js pipe `response.body` qua transform stream** — vì executor đã trả OpenAI format, transform stream là no-op passthrough (F2 fix).
- **QĐ12 — Format "devin"/"windsurf" là no-op translator (F2 fix).** KHÔNG register response translator cho "devin" hoặc "windsurf" trong `responseRegistry`. `translateResponse("devin"/"windsurf", sourceFormat, chunk, state)` → passthrough unchanged (missing translator = no-op). Executor tự đảm bảo body đã là OpenAI format. Document rõ trong Dev Notes: nếu sau này add translator "devin:openai", sẽ break — format custom = executor owns format.
- **QĐ13 — Non-streaming support (F3 fix).** Cả 2 executor phải handle `stream: false`:
  - DevinExecutor: poll tới finished → extract output → trả synthetic Response với JSON body `{id, object:"chat.completion", choices:[{index:0, message:{role:"assistant", content: output}, finish_reason:"stop"}], usage:{prompt_tokens:0, completion_tokens:0, total_tokens:0}}`.
  - WindsurfExecutor: buffer toàn bộ protobuf stream → ghép text → trả synthetic Response với JSON body cùng format.
- **QĐ14 — Không phải forced streaming (F4 fix).** `devin` và `windsurf` KHÔNG mark `providerRequiresStreaming`. Executor tự handle cả stream + non-stream. `handleForcedSSEToJson` không trigger.
- **QĐ15 — messages→prompt format (F6 fix).** DevinExecutor convert `messages[]` → `prompt` string theo format:
  ```
  [System: {system content}]
  
  User: {user content}
  
  Assistant: {assistant content}
  
  User: {user content}
  ```
  - System message optional (nếu không có, bỏ phần `[System: ...]`).
  - Multi-turn: ghép theo thứ tự, mỗi message 1 dòng `Role: content`, cách nhau bằng 2 newlines.
  - Nếu message có `content` là array (multimodal), extract text parts, ignore image/tool parts (Devin prompt là text-only).

## Acceptance Criteria

### Phase 1 — Windsurf Executor (Cascade WS)

- [ ] **AC1:** `POST /v1/chat/completions {model:"windsurf/swe", messages:[...], stream:true}` với windsurf token hợp lệ (env `WINDSURF_API_KEY` hoặc auto-extract) → fetchJwt → checkRateLimit → stream → emit OpenAI SSE với LLM tokens (true streaming)
- [ ] **AC1b:** `POST /v1/chat/completions {model:"windsurf/swe", messages:[...], stream:false}` với windsurf token hợp lệ → buffer stream → trả JSON `{choices:[{message:{content}, finish_reason:"stop"}], usage:{...}}` (F3 fix)
- [ ] **AC2:** `POST /v1/chat/completions {model:"windsurf/swe", ...}` với token sai → 401 error, không retry
- [ ] **AC3:** `POST /v1/chat/completions {model:"windsurf/swe", ...}` rate limited → 429 error
- [ ] **AC4:** `/v1/models` với `WINDSURF_API_KEY` env set → `windsurf/swe` xuất hiện trong model list (env shortcut, synthetic connection)
- [ ] **AC5:** `hasSpecializedExecutor("windsurf") === true` (executor đăng ký trong index.js)
- [ ] **AC6:** `windsurf` có trong `PROVIDERS` + `PROVIDER_MODELS` + `APIKEY_PROVIDERS` (3 registry sync)
- [ ] **AC7:** Validate endpoint `POST /api/providers/validate {provider:"windsurf", apiKey:"devin-session-token$..."}` → `valid:true` nếu fetchJwt thành công, `valid:false` nếu fail
- [ ] **AC8:** Auto-extract từ `state.vscdb` hoạt động khi env không set (port `extract-key.mjs`, `sql.js` đã có sẵn trong 9router `^1.14.1`)

### Phase 2 — Devin Executor (REST v3)

- [ ] **AC9:** `POST /v1/chat/completions {model:"devin/normal", messages:[...], stream:true}` với cog_* + orgId hợp lệ + quota → tạo session → poll → emit OpenAI SSE với output agent (1 chunk + finish_reason=stop)
- [ ] **AC9b:** `POST /v1/chat/completions {model:"devin/normal", messages:[...], stream:false}` với cog_* + orgId hợp lệ + quota → poll → trả JSON `{choices:[{message:{content:output}, finish_reason:"stop"}], usage:{prompt_tokens:0, completion_tokens:0, total_tokens:0}}` (F3 fix)
- [ ] **AC10:** `POST /v1/chat/completions {model:"devin/normal", ...}` với org hết quota → 403 `out_of_quota` error, KHÔNG fallback sang windsurf
- [ ] **AC11:** `POST /v1/chat/completions {model:"devin/normal", ...}` với orgId sai → 404 error
- [ ] **AC12:** Poll timeout (30ph default, env `DEVIN_SESSION_TIMEOUT_MS` override) → 504 error "Devin session timed out after {N}s"
- [ ] **AC12b:** Poll interval `DEVIN_POLL_INTERVAL_MS` (default 2000ms, env override) — verify env override hoạt động (F7 fix)
- [ ] **AC13:** Request abort (client disconnect) → poll dừng ngay iteration tiếp theo, không leak timeout handle
- [ ] **AC14:** `hasSpecializedExecutor("devin") === true` (executor đăng ký trong index.js)
- [ ] **AC15:** `devin_mode` mapping: `devin/normal`→`normal`, `devin/fast`→`fast`, `devin/lite`→`lite`, `devin/ultra`→`ultra`
- [ ] **AC15b:** `messages[]` → `prompt` conversion theo QĐ15 format (F6 fix): `[System: ...]\n\nUser: ...\n\nAssistant: ...`

### Cross-cutting

- [ ] **AC16:** 3 file test mới pass: `tests/unit/devin-executor.test.js`, `tests/unit/windsurf-executor.test.js`, `tests/unit/windsurf-provider-config.test.js`
- [ ] **AC17:** Full regression: 2000+ tests pass (N.1 tests vẫn pass — không sửa N.1 artifact)
- [ ] **AC18:** KHÔNG log windsurf token (`devin-session-token$...`) hoặc cog_* key trong log/error/SSE (NFR29)
- [ ] **AC19:** `usage: {prompt_tokens:0, completion_tokens:0, total_tokens:0}` placeholder cho Devin (REST v3 không trả token count)

## Tasks

### Phase 1 — Windsurf Executor (Cascade WS)

- [x] **T1:** Port protobuf utility — tạo `open-sse/utils/windsurfProtobuf.js`: port `ProtobufEncoder`, `decodeVarint`, `extractStrings`, `connectFrameEncode`, `connectFrameDecode` từ `deepgrep/src/protobuf.mjs`. Export tất cả.
- [x] **T2:** Port auth utility — tạo `open-sse/utils/windsurfAuth.js`: port `fetchJwt`, `getCachedJwt`, `_getJwtExp`, `_unaryRequest` từ `deepgrep/src/core.mjs`. Port `extractKey` từ `deepgrep/src/extract-key.mjs` (auto-extract từ state.vscdb). Export `getCachedJwt`, `extractKey`, `fetchJwt`.
- [x] **T3:** WindsurfExecutor — tạo `open-sse/executors/windsurf.js`: `class WindsurfExecutor extends BaseExecutor`. **Override `execute()` hoàn toàn, KHÔNG gọi `super.execute()` (F5).** Resolve token (env `WINDSURF_API_KEY` hoặc auto-extract) → `getCachedJwt(token)` → `checkRateLimit` → build protobuf request (`_buildMetadata` + `_buildRequest` port) → `_streamingRequest` → parse protobuf frames (`connectFrameDecode` + `extractStrings`) → extract text delta → **re-wrap thành OpenAI format** (F1):
  - `stream: true` → tạo `ReadableStream` emit OpenAI SSE chunks (`data: {choices:[{delta:{content}}]}` + `data: [DONE]`), wrap trong `new Response(stream, {status:200, headers:{"Content-Type":"text/event-stream"}})`.
  - `stream: false` → buffer toàn bộ text → JSON `{choices:[{message:{content}, finish_reason:"stop"}], usage:{...}}`, wrap trong `new Response(json, {status:200, headers:{"Content-Type":"application/json"}})`.
  - Trả `{response, url, headers, transformedBody}`. Constants: `WS_APP="windsurf"`, `WS_APP_VER`, `WS_LS_VER`, `WS_MODEL` (env override), `AUTH_BASE`, `API_BASE`. **Warning comment:** "format 'windsurf' = executor owns format. Do NOT add response translator (F2)."
- [x] **T4:** Register executor — sửa `open-sse/executors/index.js`: import `WindsurfExecutor`, add `windsurf: new WindsurfExecutor()` vào `executors` map, add export.
- [x] **T5:** windsurf provider registry — 3 file:
  - `open-sse/config/providers.js`: add `windsurf: {baseUrl:"https://server.self-serve.windsurf.com", format:"windsurf", headers:{}}`
  - `open-sse/config/providerModels.js`: add `windsurf: [{id:"swe", upstreamId:"MODEL_SWE_1_6_SLOW", name:"Windsurf SWE LLM (free tier, code search)", contextWindow:128000, maxOutput:16384}]`
  - `src/shared/constants/providers.js`: add `windsurf` vào `APIKEY_PROVIDERS` với `hasProviderSpecificData:false`, `serviceKinds:["llm"]`
- [x] **T6:** Env shortcut `/v1/models` — sửa `src/app/api/v1/models/route.js` `buildModelsList()`: add `WINDSURF_API_KEY` env check, synthetic connection `{provider:"windsurf", apiKey:env, isActive:true}` khi env set + chưa có connection active (mirror N.1 `DEVIN_API_KEY` pattern).
- [x] **T7:** Validate/testUtils case windsurf:
  - `src/app/api/providers/validate/route.js`: add `if (provider === "windsurf")` block — try `fetchJwt(apiKey)`, valid=true nếu thành công, valid=false nếu throw.
  - `src/app/api/providers/[id]/test/testUtils.js`: add `case "windsurf":` — try `fetchJwt(apiKey)`, return success/fail.
- [ ] **T8:** Test real API — start dev server với `WINDSURF_API_KEY` env, `curl POST /v1/chat/completions {model:"windsurf/swe", messages:[{role:"user",content:"hello"}]}` → verify SSE stream.

### Phase 2 — Devin Executor (REST v3)

- [x] **T9:** DevinExecutor — tạo `open-sse/executors/devin.js`: `class DevinExecutor extends BaseExecutor`. **Override `execute()` hoàn toàn, KHÔNG gọi `super.execute()` (F5).**
  - Extract `orgId` từ `credentials.providerSpecificData.orgId` hoặc `process.env.DEVIN_ORG_ID`
  - Map model → `devin_mode` (`devin/normal`→`normal`, etc.)
  - Convert `messages[]` → `prompt` text theo QĐ15 format: `[System: ...]\n\nUser: ...\n\nAssistant: ...` (F6)
  - `POST /v3/organizations/{orgId}/sessions {prompt, devin_mode}` → get `session_id`
  - Poll loop: `GET .../sessions/{session_id}` mỗi `DEVIN_POLL_INTERVAL_MS` (default 2000ms, env override — F7), check `status_enum`, check `signal.aborted`, check timeout (30ph default, env `DEVIN_SESSION_TIMEOUT_MS`)
  - `status_enum=finished` → extract `output` → **re-wrap thành OpenAI format** (F1):
    - `stream: true` → `ReadableStream` emit 1 chunk `data: {choices:[{delta:{content:output}}]}` + `data: {choices:[{delta:{}, finish_reason:"stop"}]}` + `data: [DONE]`, wrap `new Response(stream, {status:200, headers:{"Content-Type":"text/event-stream"}})`.
    - `stream: false` → JSON `{id, object:"chat.completion", choices:[{message:{role:"assistant", content:output}, finish_reason:"stop"}], usage:{prompt_tokens:0, completion_tokens:0, total_tokens:0}}`, wrap `new Response(json, {status:200, headers:{"Content-Type":"application/json"}})`.
  - `status_enum=blocked` → 503 error, `status_enum=expired` → 503 error, `status_enum=error` → 502 error
  - Timeout → 504 error, 401/403 → surface error (no retry), 404 → surface error, 5xx → surface error
  - Trả `{response, url, headers, transformedBody}`. **Warning comment:** "format 'devin' = executor owns format. Do NOT add response translator (F2)."
- [x] **T10:** Register executor — sửa `open-sse/executors/index.js`: import `DevinExecutor`, add `devin: new DevinExecutor()` vào `executors` map, add export.
- [x] **T11:** 3 file test (mock fetch):
  - `tests/unit/devin-executor.test.js`: test `DevinExecutor.execute` — 200 finished stream:true (emit SSE), 200 finished stream:false (JSON), 403 out_of_quota, 404 org, poll timeout, abort signal, status blocked/expired/error, poll interval env override (F7)
  - `tests/unit/windsurf-executor.test.js`: test `WindsurfExecutor.execute` — 200 stream:true (emit SSE), 200 stream:false (JSON buffer), 401 bad token, 429 rate limit, JWT cache
  - `tests/unit/windsurf-provider-config.test.js`: registry sync — windsurf trong PROVIDERS + PROVIDER_MODELS + APIKEY_PROVIDERS, `hasSpecializedExecutor("windsurf")===true`, `hasSpecializedExecutor("devin")===true`
- [ ] **T12:** Full regression — `cd tests && npm test` → 2000+ pass, N.1 tests vẫn pass.

## Dev Notes

- **KHÔNG log windsurf token** (`devin-session-token$...`) hoặc cog_* key ở bất kỳ đâu (NFR29). Không return trong API response, không trong error message, không trong SSE stream.
- **KHÔNG sửa N.1 artifact.** Không đụng `devin` registry đã chốt (PROVIDERS, PROVIDER_MODELS, APIKEY_PROVIDERS). Không sửa validate/testUtils case `devin`. Không sửa devin env shortcut. Chỉ ADD case `windsurf` và ADD executor `devin`.
- **Port protobuf nguyên vẹn** từ deepgrep — không sửa logic encode/decode, chỉ adapt import/export sang ESM 9router. Test từng function độc lập nếu cần.
- **Poll loop abort-safe:** check `signal.aborted` trước mỗi iteration, `clearTimeout` khi done/throw, không leak handle.
- **`format: "windsurf"` và `format: "devin"` là custom** — đảm bảo không có nơi nào assume format ∈ {openai, claude, gemini,...} mà crash khi gặp "windsurf"/"devin" ở các đường mã N.2 chạm tới.
- **Windsurf token expire:** `getCachedJwt` check `exp` (port `_getJwtExp`), refresh auto khi within 60s of expiration. Document: user phải re-login IDE nếu token expire hoàn toàn.
- **Devin `output` field:** REST v3 trả `output` field trong session object khi `status_enum=finished`. Emit nguyên `output` làm 1 chunk. Nếu `output` rỗng → emit content `""` + `finish_reason=stop` (không crash).
- **Devin `usage`:** REST v3 không trả token count. `usage: {prompt_tokens:0, completion_tokens:0, total_tokens:0}` placeholder, document rõ.
- **Windsurf `WS_MODEL` env:** Default `MODEL_SWE_1_6_SLOW`, env `WS_MODEL` override (mirror deepgrep `core.mjs:88`).
- **Windsurf `WS_APP_VER`/`WS_LS_VER`:** Default từ deepgrep (`1.48.2`/`1.9544.35`), env override nếu cần.
- **Auto-extract `state.vscdb`:** Port `extract-key.mjs` đọc `windsurfAuthStatus.apiKey` từ DB. `sql.js` đã có sẵn trong 9router (`^1.14.1`, verified F8). Risk: server deploy không có IDE → auto-extract fail → phải set env `WINDSURF_API_KEY`. Document rõ trong error message.
- **Test deps:** `cd /Users/luisphan/Documents/9router/tests && npm test -- unit/<file>.test.js` (vitest, alias `@/`→`src/`, deps `/tmp/node_modules`).
- **F1 — Executor return contract (CRITICAL):** Cả `DevinExecutor` và `WindsurfExecutor` override `execute()` hoàn toàn, **KHÔNG gọi `super.execute()`**. Trả về `{response, url, headers, transformedBody}`:
  - `response` = synthetic `new Response(body, {status:200, headers})` với body đã là **OpenAI format** (SSE stream hoặc JSON).
  - `stream: true` → body là `ReadableStream` emit `data: {choices:[{index:0, delta:{content:"..."}, finish_reason:null}]}\n\n` → `data: {choices:[{index:0, delta:{}, finish_reason:"stop"}]}\n\n` → `data: [DONE]\n\n`. Header `Content-Type: text/event-stream`.
  - `stream: false` → body là JSON string `{id:"chatcmpl-...", object:"chat.completion", created:<ts>, model:"devin/normal", choices:[{index:0, message:{role:"assistant", content:"..."}, finish_reason:"stop"}], usage:{prompt_tokens:0, completion_tokens:0, total_tokens:0}}`. Header `Content-Type: application/json`.
  - `url`/`headers`/`transformedBody` = upstream info cho log (không ảnh hưởng response body).
- **F2 — No translator registration:** KHÔNG register response translator cho "devin" hoặc "windsurf" trong `open-sse/translator/index.js` `responseRegistry`. `translateResponse("devin"/"windsurf", sourceFormat, chunk, state)` → missing translator → passthrough unchanged. Executor tự đảm bảo body đã là OpenAI format. **Warning comment trong executor file:** "format 'devin'/'windsurf' = executor owns format. Do NOT add response translator — will break passthrough."
- **F5 — Total override execute():** WindsurfExecutor KHÔNG reuse `buildUrl`/`buildHeaders`/`transformRequest`/`proxyAwareFetch`/retry logic từ BaseExecutor. Protocol protobuf WS khác hoàn toàn REST JSON. Override `execute()` từ đầu, chỉ reuse `this.provider`/`this.config` cho identity.

## Out of scope (defer)

- UI connection cho windsurf (AddApiKeyModal + EditConnectionModal) — defer story sau. N.2 env-only.
- True streaming cho Devin (REST v3 không support stream, chỉ poll) — chấp nhận fake-stream 1 chunk.
- WebSocket reconnect cho windsurf — defer (port basic trước, retry có sẵn trong `_streamingRequest`).
- Caching session output cho Devin — defer.
- Quota/billing display trong UI — defer.
- Devin session cancellation (POST cancel) khi abort — defer (chỉ dừng poll, không cancel session upstream).

## Risks

| Rủi ro | Mức | Mitigation |
|---|---|---|
| Poll-to-finished block connection lâu (phút-giờ) | HIGH | Timeout 30ph + env override + abort signal. Document: `devin/*` không phù hợp chat realtime, phù hợp agent task async |
| Port protobuf từ deepgrep có thể break | HIGH | Port từng function, test độc lập. Mirror deepgrep code nguyên vẹn, chỉ adapt import/export |
| Windsurf token expire (session JWT) | MEDIUM | `getCachedJwt` check exp, refresh auto. Document: user phải re-login IDE nếu token expire |
| Org user hết quota REST v3 | MEDIUM (external) | Surface 403 `out_of_quota` rõ ràng. KHÔNG fallback. Document: user phải topup hoặc dùng `windsurf/swe` (free) |
| 5 artifact đụng > 3 handler | MEDIUM | User đã chọn 1 story lớn. Review kỹ, test đầy đủ, ready rollback từng executor |
| `windsurf` provider mới chưa có UI connection | LOW | N.2 env-only. UI connection defer story sau |
| Protobuf binary parse fragile | MEDIUM | Port `extractStrings` từ deepgrep (đã test). Fallback: nếu parse fail → emit raw text |
| Executor return contract sai format (F1) | HIGH (resolved) | QĐ11 + Dev Notes F1 chốt synthetic Response + OpenAI format. Test verify cả stream + non-stream |
| No translator registration drift (F2) | MEDIUM (resolved) | QĐ12 + Dev Notes F2 chốt no-op passthrough. Warning comment trong executor file |
| Non-streaming không handle (F3) | HIGH (resolved) | QĐ13 + AC1b/AC9b + T3/T9 chốt stream:false → JSON. Test cover cả 2 mode |
| Total override execute() không rõ (F5) | MEDIUM (resolved) | QĐ11 + Dev Notes F5 chốt KHÔNG gọi super.execute() |
| messages→prompt format drift (F6) | MEDIUM (resolved) | QĐ15 + AC15b + T9 chốt format cụ thể |
| Poll interval lệch epics (F7) | LOW (resolved) | QĐ6 + AC12b + T9 chốt DEVIN_POLL_INTERVAL_MS env |
| `sql.js` dependency (F8) | LOW (resolved) | Đã verify `sql.js@^1.14.1` có sẵn trong 9router, Node v22 OK |

### Review Findings

#### Decision-needed (3)

- [x] [Review][Decision→Patch] Windsurf "true streaming" thực ra là buffered-then-faked — **QUYẾT ĐỊNH: Fix ngay** — rework `_streamingRequest` thành stream reader → decode frames incremental [open-sse/utils/windsurfAuth.js:898-899, open-sse/executors/windsurf.js:581]
- [x] [Review][Decision→Dismiss] `extractStrings` drop tất cả strings ≤5 chars — **QUYẾT ĐỊNH: Giữ nguyên >5** — threshold từ deepgrep đã test, JWT extraction dựa trên filter này [open-sse/utils/windsurfProtobuf.js:168]
- [x] [Review][Decision→Patch] Tools silently dropped — **QUYẾT ĐỊNH: Implement tool support** — map OpenAI tools sang Devin prompt + Windsurf toolDefs [open-sse/executors/windsurf.js:68, open-sse/executors/devin.js:42]

#### Patch (18)

- [x] [Review][Patch] `devin_mode` shorthand ReferenceError — biến khai báo `devinMode` nhưng dùng `{ devin_mode }` shorthand lookup `devin_mode` (không tồn tại) → ReferenceError trên mọi Devin request [open-sse/executors/devin.js:275]
- [x] [Review][Patch] Missing 2/3 test files — spec T11 yêu cầu `devin-executor.test.js` + `windsurf-executor.test.js` (mock fetch) nhưng chưa tạo. AC16/AC17 không thỏa [tests/unit/]
- [x] [Review][Patch] TLS fallback disable cert verification process-wide — `_applyTlsFallback()` set `NODE_TLS_REJECT_UNAUTHORIZED=0` global trên ANY network error (không chỉ TLS). Trong multi-tenant server = MITM exposure cho tất cả provider [open-sse/utils/windsurfAuth.js:71-82]
- [x] [Review][Patch] `modeMap` keys không match — keys `"devin/normal"` nhưng `model` arg là `"normal"` (post-slash). Tất cả mode trừ normal silently degrade [open-sse/executors/devin.js:33-39]
- [x] [Review][Patch] WindsurfExecutor ignore `credentials.apiKey` — đọc env trước, DB connection không bao giờ dùng. Comment route.js nói "DB takes precedence" nhưng executor làm ngược [open-sse/executors/windsurf.js:537-546]
- [x] [Review][Patch] Abort signal không forwarded to upstream — `_streamingRequest` và `_unaryRequest` không nhận `signal` param. Client abort không cancel upstream fetch [open-sse/utils/windsurfAuth.js:113,191]
- [x] [Review][Patch] `proxyOptions` ignored — cả 2 executor dùng raw `fetch()` thay vì `proxyAwareFetch()`. Tất cả proxy features bypassed [open-sse/executors/devin.js:50,101, open-sse/executors/windsurf.js:82,141]
- [x] [Review][Patch] Multimodal array `content` corrupted — Windsurf pass `m.content` raw đến `writeString` → `Buffer.from(arrayOfObjects,"utf-8")` = null bytes. Devin có `_extractTextContent` nhưng Windsurf không [open-sse/executors/windsurf.js:61-65]
- [x] [Review][Patch] Executor errors collapse to HTTP 502 — tất cả `throw new Error()` trở thành 502 qua chatCore catch. AC yêu cầu 401/403/404/429/503/504 cụ thể. Fix: return synthetic error Response với đúng status [open-sse/executors/devin.js:294-303, open-sse/executors/windsurf.js:553-557]
- [x] [Review][Patch] Poll sleep không abort-safe — `setTimeout` không `clearTimeout`, signal chỉ check iteration tiếp theo. AC13 yêu cầu "không leak timeout handle" [open-sse/executors/devin.js:327]
- [x] [Review][Patch] Devin session không cancel on abort — poll throw nhưng không gọi DELETE/cancel API. Session tiếp tục chạy và bill cho đến khi finish/expire [open-sse/executors/devin.js:89-110]
- [x] [Review][Patch] Poll fail permanent trên non-2xx — transient 5xx (500/502/503) → throw ngay, mất toàn bộ session result đã bill [open-sse/executors/devin.js:108-110]
- [x] [Review][Patch] Unknown `status_enum` spin đến 30min timeout — `cancelled`/`failed` không có branch → poll vô hạn [open-sse/executors/devin.js:113-130]
- [x] [Review][Patch] JWT cache không invalidate on auth failure — 401 từ upstream không clear cache. Bad token reused cho đến khi `exp` pass (up to 1h) [open-sse/utils/windsurfAuth.js:55-63]
- [x] [Review][Patch] Malformed JWT cached 1h — `_getJwtExp` return 0 → `exp || now+3600` cache fallback. Non-JWT string bắt đầu `eyJ` được cache [open-sse/utils/windsurfAuth.js:62]
- [x] [Review][Patch] Windsurf streaming không emit `finish_reason` on error — `controller.error(e)` không emit final chunk. Client hang waiting for terminator [open-sse/executors/windsurf.js:81-124]
- [x] [Review][Patch] `connectFrameDecode` accept truncated frames — no bounds check `i+length <= data.length`. Network drop → garbage payload emit as content [open-sse/utils/windsurfProtobuf.js:218-236]
- [x] [Review][Patch] Dead code `hasSystem` + `transformedBody` sai + `chatcmpl-` ID không unique [open-sse/executors/devin.js:460,468,413,448, open-sse/executors/windsurf.js:637,676]

#### Deferred (7)

- [x] [Review][Defer] `checkRateLimit` return true trên non-429 error — port từ deepgrep, fail-open pattern [open-sse/utils/windsurfAuth.js:265-268] — deferred, pre-existing port pattern
- [x] [Review][Defer] Token usage hardcoded 0 — AC19 explicitly placeholder cho Devin; Windsurf cũng không có token count [open-sse/executors/devin.js:429-433] — deferred, spec-sanctioned
- [x] [Review][Defer] `extractKey` dùng `readFileSync` blocking I/O — port từ deepgrep, chỉ chạy trên cache miss [open-sse/utils/windsurfAuth.js:1124-1126] — deferred, pre-existing port pattern
- [x] [Review][Defer] `_jwtCache` unbounded Map — low impact, pre-existing pattern [open-sse/utils/windsurfAuth.js:43] — deferred, pre-existing
- [x] [Review][Defer] Validate route Devin dùng raw `fetch` không proxy — pre-existing từ N.1 [src/app/api/providers/validate/route.js:125-128] — deferred, pre-existing
- [x] [Review][Defer] `fetchJwt` pick first `eyJ` string heuristic — port từ deepgrep, works in practice [open-sse/utils/windsurfAuth.js:934-938] — deferred, pre-existing port pattern
- [x] [Review][Defer] `decodeVarint` overflow >32 bits — chỉ affect >256MB payload, unrealistic [open-sse/utils/windsurfProtobuf.js:160] — deferred, unrealistic
