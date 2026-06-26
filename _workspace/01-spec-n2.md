# Spec N.2 — Devin Executor (REST v3) + Windsurf Executor (Cascade WS)

> **Status:** approved — user đã sign-off 4 open questions, sẵn sàng implement
> **Date:** 2026-06-25
> **Prerequisite:** N.1 done (provider config + 4 model tĩnh + validate + env shortcut)
> **Scope flag:** Đụng **5 core artifact** (2 executor mới + 2 registry windsurf + validate/testUtils windsurf + models route windsurf env) — VƯỢT ngưỡng 3 handler mà skill `9r-feature-spec` khuyến nghị chẻ nhỏ. User đã chọn "1 story lớn" → giữ nguyên nhưng flag risk cao.
>
> **Update 2026-06-26 (post-launch):** Catalog windsurf mở rộng từ 1 model lên ~60+ model. Canonical model đổi: `windsurf/swe` (upstream `MODEL_SWE_1_6_SLOW`) → `windsurf/swe-1-6` (upstream `swe-1-6`). `WS_MODEL` default đổi sang `swe-1-6`. QĐ7/AC3-AC5 dưới đây vẫn ghi `windsurf/swe` (historical) — canonical hiện tại = `windsurf/swe-1-6`.

## Mục tiêu (User story)

**Mục tiêu tổng:** Expose toàn bộ model Devin (4 mode agent + 1 LLM chat windsurf) qua 9router `/v1/chat/completions` để agent khác gọi được qua OpenAI-compatible API.

**Story:** Tôi là developer tích hợp 9router, tôi muốn **gọi `devin/normal|fast|lite|ultra` (agent session) và `windsurf/swe` (LLM chat free tier) qua `/v1/chat/completions`**, để **agent khác (Claude, GPT, custom bot) có thể dùng Devin agent + Windsurf LLM qua 1 endpoint thống nhất**.

## Bối cảnh & quyết định architecture

### 2 hệ thống khác nhau (không fallback silently)

| | REST v3 Devin | Cascade WS Windsurf |
|---|---|---|
| Endpoint | `https://api.devin.ai/v3/organizations/{org_id}/sessions` | `wss://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService` |
| Auth | `cog_*` + `org_id` | `devin-session-token$eyJ...` (windsurf session token) |
| Protocol | REST JSON | Protobuf-over-WebSocket (connect-frame) |
| Output | Structured agent output (sau `status_enum=finished`) | Streaming tokens (LLM chat) |
| Thời gian | Phút → giờ | Giây |
| Billing | ACU quota (org user hết quota → 403) | Free tier |
| Use case | "Devin fix bug này" (agent task) | "Search codebase / chat LLM" |

→ **KHÔNG fallback** giữa 2 hệ thống. Mỗi model có executor riêng, surface error thật cho user.

### Quyết định

- **QĐ1 — 2 executor riêng, 2 provider riêng.** `DevinExecutor` (provider `devin`, đã có N.1) + `WindsurfExecutor` (provider `windsurf`, NEW). Lý do: 2 protocol/auth/output khác hoàn toàn, không thể gộp.
- **QĐ2 — `windsurf` là provider mới.** Phải add vào 3 registry (giống N.1 pattern): `PROVIDERS` (open-sse/config/providers.js), `PROVIDER_MODELS` (1 model `swe`), `APIKEY_PROVIDERS` (src/shared/constants/providers.js). `format: "windsurf"` (custom).
- **QĐ3 — DevinExecutor: REST v3 wrap.** `POST /v3/organizations/{org_id}/sessions {devin_mode}` → poll `GET .../sessions/{id}` mỗi 2s tới `status_enum=finished` (timeout 30ph) → extract `output` → emit OpenAI SSE (fake-stream, chunk output thành delta). 403 `out_of_quota` → surface error, KHÔNG fallback sang windsurf.
- **QĐ4 — WindsurfExecutor: port protobuf từ deepgrep.** Port `fetchJwt`, `checkRateLimit`, `_buildRequest`, `_streamingRequest`, `connectFrameEncode`, `ProtobufEncoder` từ `deepgrep/src/core.mjs` + `protobuf.mjs`. Parse protobuf response → extract text delta → re-wrap thành OpenAI SSE. True streaming.
- **QĐ5 — Windsurf auth: env `WINDSURF_API_KEY` hoặc auto-extract.** Env shortcut `WINDSURF_API_KEY` (token `devin-session-token$...`) + `DEVIN_ORG_ID` không cần (WS không dùng org). Auto-extract từ `state.vscdb` qua logic `extract-key.mjs` (port sang 9router) nếu env không set. KHÔNG lưu DB connection cho windsurf ở N.2 (env-only, defer UI connection sang story sau).
- **QĐ6 — Polling là pattern mới, không có tiền lệ trong 9router.** Các executor hiện tại (codex/kiro/cursor/qoder) đều true-stream hoặc unwrap envelope, không có poll-to-finished. DevinExecutor phải implement poll loop mới + timeout + abort. Risk: block 1 connection slot lâu (phút-giờ).
- **QĐ7 — Model `windsurf/swe` mapping.** `PROVIDER_MODELS["windsurf"] = [{ id: "swe", name: "Windsurf SWE LLM (free tier, code search)", ... }]`. Upstream model = `MODEL_SWE_1_6_SLOW` (env override `WS_MODEL`).
- **QĐ8 — KHÔNG sửa N.1 artifact.** Không đụng `devin` registry đã chốt. Không sửa validate/testUtils case `devin` (chỉ ADD case `windsurf`).

## 4 mặt chốt (cho 3 người làm song song)

### Mặt 1: Provider/Executor

**Provider `devin` (N.1 đã có, N.2 chỉ thêm executor):**
- `open-sse/executors/devin.js` (NEW) — `class DevinExecutor extends BaseExecutor`
- `open-sse/executors/index.js` — import + register `devin: new DevinExecutor()`

**Provider `windsurf` (NEW):**
- `open-sse/config/providers.js` — add `windsurf: { baseUrl: "https://server.self-serve.windsurf.com", format: "windsurf", headers: {...} }`
- `open-sse/config/providerModels.js` — add `windsurf: [{ id: "swe", upstreamId: "MODEL_SWE_1_6_SLOW", ... }]`
- `src/shared/constants/providers.js` — add `windsurf` vào `APIKEY_PROVIDERS` với `hasProviderSpecificData: false` (env-only, không có orgId field)
- `open-sse/executors/windsurf.js` (NEW) — `class WindsurfExecutor extends BaseExecutor`
- `open-sse/executors/index.js` — import + register `windsurf: new WindsurfExecutor()`
- `open-sse/utils/windsurfProtobuf.js` (NEW) — port `ProtobufEncoder`, `connectFrameEncode`, `extractStrings` từ deepgrep
- `open-sse/utils/windsurfAuth.js` (NEW) — port `fetchJwt`, `getCachedJwt`, `extractKey` từ deepgrep (extract từ state.vscdb nếu env không set)

### Mặt 2: Core handler

**Không có core handler mới** — N.2 chỉ thêm executor. `/v1/chat/completions` route đã có, dispatch qua `getExecutor(provider)` đã có. Executor là nơi logic nằm.

**Boundary để test (cho contract-tester):**
- `DevinExecutor.execute({ model, body, stream, credentials })` — mock `fetch` (REST v3), verify: POST session → poll → emit SSE. Test 200 finished, 403 out_of_quota, 404 org, timeout.
- `WindsurfExecutor.execute({ model, body, stream, credentials })` — mock WebSocket/`fetch` (JWT + streaming), verify: fetchJwt → checkRateLimit → stream → emit SSE. Test 200 stream, 401 bad token, 429 rate limit.
- **KHÔNG test qua `/v1/chat/completions` endpoint** (cần DB + auth + quota) — test executor trực tiếp (pattern mới, không có tiền lệ exact, mirror theo `tests/unit/devin-validate.test.js` mock-fetch style).

### Mặt 3: Route

**Không có route mới.** `/v1/chat/completions` đã có (dispatch qua executor). `/v1/models` đã có (N.1 đã add env shortcut devin, N.2 add env shortcut windsurf).

**Sửa nhỏ:**
- `src/app/api/v1/models/route.js` — add `WINDSURF_API_KEY` env shortcut (giống `DEVIN_API_KEY` pattern N.1, synthetic connection khi env set + chưa có connection active)
- `src/app/api/providers/validate/route.js` — add `case "windsurf":` (validate windsurf token qua `fetchJwt` — nếu fetch được JWT = token hợp lệ)
- `src/app/api/providers/[id]/test/testUtils.js` — add `case "windsurf":` (test connection windsurf)

**Cờ force-dynamic:** `/v1/models` đã có `force-dynamic` (N.1). Validate route đã có. Không thêm route mới → không thêm cờ mới.

### Mặt 4: Contract test

**3 file test mới (mirror N.1 pattern):**
- `tests/unit/devin-executor.test.js` — test `DevinExecutor.execute` với mock fetch: 200 finished (emit SSE), 403 out_of_quota (surface error), 404 org (surface error), poll timeout (30ph → error), abort signal
- `tests/unit/windsurf-executor.test.js` — test `WindsurfExecutor.execute` với mock WS/fetch: 200 stream (emit SSE), 401 bad token, 429 rate limit, JWT cache
- `tests/unit/windsurf-provider-config.test.js` — registry sync (giống `devin-provider-config.test.js`): windsurf có trong PROVIDERS + PROVIDER_MODELS + APIKEY_PROVIDERS, `hasSpecializedExecutor("windsurf") === true`, `hasSpecializedExecutor("devin") === true` (N.2 thêm executor devin)

**Regression:**
- `devin-provider-config.test.js` (N.1) vẫn pass — N.2 không sửa N.1 registry
- `devin-models-route.test.js` (N.1) vẫn pass — N.2 không sửa devin env shortcut
- `devin-validate.test.js` (N.1) vẫn pass — N.2 không sửa case devin
- Full suite 2000 tests vẫn pass

## Cờ rủi ro

| Rủi ro | Mức | Mitigation |
|---|---|---|
| Poll-to-finished block connection lâu (phút-giờ) | HIGH | Timeout 30ph + abort signal. Document rõ: `devin/*` không phù hợp chat realtime, phù hợp agent task async |
| Port protobuf từ deepgrep có thể break | HIGH | Port từng function, test độc lập từng bước (fetchJwt → checkRateLimit → stream). Mirror deepgrep test nếu có |
| Windsurf token expire (session JWT) | MEDIUM | `getCachedJwt` check exp, refresh auto. Document: user phải re-login IDE nếu token expire |
| Org user hết quota REST v3 | MEDIUM (external) | Surface 403 `out_of_quota` rõ ràng. KHÔNG fallback. Document: user phải topup hoặc dùng `windsurf/swe` (free) |
| 5 artifact đụng > 3 handler | MEDIUM | User đã chọn 1 story lớn. Review kỹ, test đầy đủ, ready rollback từng executor |
| `windsurf` provider mới chưa có UI connection | LOW | N.2 env-only. UI connection (AddApiKeyModal cho windsurf) defer story sau |
| Protobuf binary parse fragile | MEDIUM | Port `extractStrings` từ deepgrep (đã test). Fallback: nếu parse fail → emit raw text |

## Out of scope (defer)

- UI connection cho windsurf (AddApiKeyModal + EditConnectionModal) — defer story sau
- True streaming cho Devin (REST v3 không support stream, chỉ poll) — chấp nhận fake-stream
- WebSocket reconnect cho windsurf — defer (port basic trước)
- Caching session output cho Devin — defer
- Quota/billing display trong UI — defer

## Acceptance Criteria (draft)

- **AC1:** `POST /v1/chat/completions {model:"devin/normal", messages:[...]}` với cog_* + orgId hợp lệ + quota → tạo session → poll → emit OpenAI SSE với output agent
- **AC2:** `POST /v1/chat/completions {model:"devin/normal", ...}` với org hết quota → 403 `out_of_quota` error, KHÔNG fallback
- **AC3:** `POST /v1/chat/completions {model:"windsurf/swe", messages:[...]}` với windsurf token hợp lệ → fetchJwt → stream → emit OpenAI SSE với LLM tokens
- **AC4:** `POST /v1/chat/completions {model:"windsurf/swe", ...}` với token sai → 401 error
- **AC5:** `/v1/models` với `WINDSURF_API_KEY` env set → `windsurf/swe` xuất hiện trong model list
- **AC6:** `hasSpecializedExecutor("devin") === true` && `hasSpecializedExecutor("windsurf") === true`
- **AC7:** Validate endpoint `POST /api/providers/validate {provider:"windsurf", apiKey:"devin-session-token$..."}` → `valid:true` nếu fetchJwt thành công
- **AC8:** 3 file test mới pass + full regression 2000 tests pass
- **AC9:** KHÔNG log windsurf token hoặc cog_* key trong log/error (NFR29)

## Quyết định bổ sung (user sign-off 2026-06-25)

1. **Poll timeout Devin:** 30ph default + env `DEVIN_SESSION_TIMEOUT_MS` override. Không break OpenAI API shape.
2. **Windsurf token:** Auto-extract từ `state.vscdb` (port `extract-key.mjs`) + env `WINDSURF_API_KEY` fallback. Risk server deploy không có IDE → phải set env (document rõ).
3. **Devin output:** Emit nguyên `output` làm 1 chunk delta + `finish_reason=stop`. Đơn giản, agent nhận 1 message lớn. Không true stream (REST v3 không support).
4. **Windsurf `WS_MODEL`:** Default `MODEL_SWE_1_6_SLOW` + env `WS_MODEL` override (mirror deepgrep, best practice production).
