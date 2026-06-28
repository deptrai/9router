# Boundary QA — Feature `mitm-windsurf-devin-cli`

> Tác giả: 9r-feature-orchestrator (Phase 3a, boundary-qa direct)
> Ngày: 2026-06-29 (cập nhật 2026-06-29 sau e2e fix)
> **VERDICT: PASS**

## Shape check route ↔ core ↔ test

### 1. `intercept()` signature khớp caller `server.js`

| Mặt | Caller (`server.js:345`) | Handler (`windsurf.js:349`) | Khớp? |
|-----|--------------------------|----------------------------|-------|
| Args | `handlers[tool].intercept(req, res, bodyBuffer, null, passthrough)` | `async function intercept(req, res, bodyBuffer, mappedModel, _passthrough)` | ✅ 5 args đúng thứ tự |
| Export | `handlers.windsurf = require("./handlers/windsurf")` (server.js:42) | `module.exports = { intercept, translateToAnthropic, resolveModelAlias }` | ✅ `intercept` có |
| Special-case | `if (tool === "cursor" \|\| tool === "windsurf")` (server.js:344) delegate thẳng, bỏ qua `extractModel` | handler nhận `mappedModel=null`, tự extract `modelUid` từ protobuf field 21 | ✅ consistent |

### 2. `fetchRouter` path tồn tại

| Mặt | Handler call | Route file | Khớp? |
|-----|--------------|------------|-------|
| Path | `fetchRouter(anthropicBody, "/v1/messages", req.headers)` (windsurf.js) | `src/app/api/v1/messages/route.js` EXISTS | ✅ |
| Route dispatch | `/v1/messages` POST → `handleChat` → provider có `format: "claude"` | `PROVIDERS.windsurf.format = "claude"` (providers.js:441) | ✅ WindsurfExecutor sẽ nhận request |
| force-dynamic | route đã có `export const dynamic = "force-dynamic"` (route.js:4) | không cần thêm | ✅ |

### 3. Config windsurf consistent 3 nơi

| File | Entry | Khớp? |
|------|-------|-------|
| `src/mitm/config.js:22` | `TARGET_HOSTS += "server.codeium.com"` | ✅ |
| `src/mitm/config.js:30` | `URL_PATTERNS.windsurf = ["/exa.api_server_pb.ApiServerService/GetChatMessage"]` | ✅ khớp `PROVIDERS.windsurf.baseUrl` path |
| `src/mitm/config.js:72` | `getToolForHost("server.codeium.com") → "windsurf"` | ✅ |
| `src/shared/constants/mitmToolHosts.js:10` | `TOOL_HOSTS.windsurf = ["server.codeium.com"]` | ✅ |
| `src/mitm/server.js:42` | `handlers.windsurf = require("./handlers/windsurf")` | ✅ |
| `src/shared/constants/cliTools.js` | `MITM_TOOLS.windsurf` entry (UI toggle) | ✅ |

### 4. `MITM_BYPASS_HOSTS` consistent với `TOOL_HOSTS`

| File | Entry | Khớp? |
|------|-------|-------|
| `open-sse/utils/proxyFetch.js` | `MITM_BYPASS_HOSTS = [..., "server.codeium.com"]` | ✅ |
| `src/shared/constants/mitmToolHosts.js` | `TOOL_HOSTS.windsurf = ["server.codeium.com"]` | ✅ |
| Lý do | 9router outbound tới `server.codeium.com` phải bypass `/etc/hosts` MITM override (resolve real IP qua Google DNS) | ✅ tránh DNS loop |

### 5. Contract test

| Mặt | Trạng thái |
|-----|-----------|
| File | `tests/unit/windsurf-mitm-contract.test.js` |
| Result | 37/37 PASS (7 group assertion theo spec) |
| Boundary | 3 pure function + frame split + `resolveModelAlias` normalize suffix (per spec), `intercept()` không test (I/O nặng) |

## Bẫy đã kiểm

| Bẫy | Status |
|-----|--------|
| force-dynamic | ✅ không cần (feature không động route /v1) |
| auth | ✅ handler strip `metadata.apiKey` của client, 9router inject credential rotate từ DB |
| executor index | ✅ WindsurfExecutor đã đăng ký, không thêm executor mới |
| `extractModel` parse protobuf | ✅ special-case delegation (như cursor) bỏ qua `extractModel`, handler tự decode |
| CJS/ESM boundary | ✅ handler (CJS) `require` windsurfProtobuf.js (ESM) — Node reparsing typeless package, runtime OK |
| **DNS loop** | ✅ `server.codeium.com` thêm vào `MITM_BYPASS_HOSTS` — 9router outbound resolve real IP, không loop về MITM |
| **Buffer serialization** | ✅ `createBypassRequest` gửi raw Buffer (fix `JSON.stringify(Buffer)` bug) |
| **modelUid variant suffix** | ✅ regex `/-max(?:-\w+)?$/i` match cả `-max` lẫn `-max-1m` |

## VERDICT: PASS

Không drift shape. 2 bug e2e đã fix (xem `07-e2e-root-cause-fix.md`). Có thể sang deploy-gate.
