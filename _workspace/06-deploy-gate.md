# Deploy Gate — Feature `mitm-windsurf-devin-cli`

> Tác giả: 9r-feature-orchestrator (Phase 3b, deploy-gate direct)
> Ngày: 2026-06-29 (cập nhật 2026-06-29 sau e2e fix)
> **VERDICT: PASS** (code + test + e2e direct đã PASS; chờ user bật MITM toggle + test e2e với Devin CLI)

## Diff summary

**5 file modified + 2 file mới** (Phase 2):
| File | Loại | LOC |
|------|------|-----|
| `open-sse/utils/windsurfProtobuf.js` | modified | +244 (inverse functions + bug fix) |
| `src/mitm/handlers/windsurf.js` | **new** | 418 (full intercept pipeline + auto-map modelUid) |
| `src/mitm/config.js` | modified | +3 (host, URL pattern, getToolForHost) |
| `src/mitm/server.js` | modified | +8/-5 (register handler + special-case) |
| `src/shared/constants/cliTools.js` | modified | +16 (UI toggle MITM_TOOLS.windsurf) |
| `src/shared/constants/mitmToolHosts.js` | modified | +1 (TOOL_HOSTS.windsurf) |
| `tests/unit/windsurf-mitm-contract.test.js` | **new** | 320 (37 contract tests) |

**2 file modified** (Phase 3c, e2e fix):
| File | Loại | LOC | Lý do |
|------|------|-----|-------|
| `open-sse/utils/proxyFetch.js` | modified | +12/-3 | Fix `createBypassRequest` gửi raw Buffer thay vì `JSON.stringify(Buffer)` — root cause 429 "internal error" |
| `src/mitm/handlers/windsurf.js` | modified | +2/-2 | Fix regex `/-max(?:-\w+)?$/i` match cả `-max` lẫn `-max-1m` (modelUid passthrough bug) |

## Impact radius

| File thay đổi | Caller ảnh hưởng | Risk |
|---------------|------------------|------|
| `windsurfProtobuf.js` (+inverse) | `WindsurfExecutor` (outbound, untouched) + handler mới (inbound) | LOW: chỉ thêm export, backward compat giữ |
| `windsurf.js` (new) | chỉ `server.js` import qua `handlers.windsurf` | LOW: file mới |
| `config.js` (+windsurf) | `server.js` dùng `getToolForHost`/`URL_PATTERNS`/`TARGET_HOSTS` | LOW: chỉ thêm entry |
| `server.js` (special-case) | mọi tool đều qua branch này | LOW: thêm `\|\| tool === "windsurf"` vào condition có sẵn, cursor vẫn hoạt động |
| `cliTools.js` (+MITM_TOOLS.windsurf) | UI iterate `MITM_TOOLS` | LOW: thêm entry, UI generic render |
| `mitmToolHosts.js` (+TOOL_HOSTS.windsurf) | `dnsConfig.addDNSEntry`/`removeDNSEntry` generic | LOW: thêm entry |
| `proxyFetch.js` (fix Buffer) | `createBypassRequest` — caller: WindsurfExecutor ( Windsurf), CursorExecutor, CopilotExecutor, AntigravityExecutor khi `MITM_BYPASS_HOSTS` match | **MEDIUM**: fix cho mọi executor dùng bypass path, nhưng chỉ Windsurf gửi Buffer (Cursor/Copilot gửi JSON) → backward compat |
| `windsurf.js` (fix regex) | `resolveModelAlias` — caller: `intercept()` trong cùng file | LOW: chỉ mở rộng pattern match |

## Force-dynamic check

| Route | force-dynamic | Cần thêm? |
|-------|---------------|-----------|
| `src/app/api/v1/messages/route.js` | ✅ đã có (line 4) | KHÔNG — feature không động route |
| Route mới | không có route mới | KHÔNG |

## Env Dokploy

| Env | Cần set? | Lý do |
|-----|----------|-------|
| `MITM_ROUTER_BASE` | đã có | MITM server forward tới 9router (tái use) |
| `ROUTER_API_KEY` | đã có | auth MITM→9router (tái use) |
| Env mới | KHÔNG | feature không cần env mới |

## Security check

| Mặt | Status |
|-----|--------|
| Endpoint mới | KHÔNG — `/v1/messages` đã có, đã require auth |
| Credential leak | ✅ handler **strip `metadata.apiKey`** của client, 9router inject credential rotate từ DB |
| Cert MITM | ✅ CA "9Router MITM Root CA" đã trust trong System.keychain (Phase 1 verify) |
| ToS risk | 🟡 NON-TECHNICAL — rotate nhiều account Windsurf vi phạm ToS Cognition. Đã thông báo user. |

## Test coverage

| Test | Result |
|------|--------|
| `tests/unit/windsurf-mitm-contract.test.js` (37 tests, 7 group) | ✅ 37/37 PASS |
| Roundtrip manual (29 assertions, dọn sau) | ✅ 29/29 PASS |
| translateToAnthropic manual (17 assertions, dọn sau) | ✅ 17/17 PASS |
| Phase 1 cert verify (Connect-RPC request thật qua MITM, "Hello" response) | ✅ PASS |
| **E2E direct 9router** (3 case: simple/system/tools) | ✅ **200 PASS** (sau fix Buffer) |
| **E2E `proxyAwareFetch` bypass** (raw Buffer) | ✅ **200 PASS** (sau fix Buffer) |

## E2E verification (Phase 3c, sau fix)

| Test case | Trước fix | Sau fix |
|-----------|-----------|---------|
| `proxyAwareFetch` (createBypassRequest, Buffer body) | 429 "internal error" | **200 ✅** (raw Buffer) |
| 9router full path — simple (1 msg) | 429 | **200 ✅** "Hi!" |
| 9router full path — with system prompt | 429 | **200 ✅** "Hi! 👋" + thinking |
| 9router full path — with 1 tool | 429 | **200 ✅** "Hi there!" + thinking |

## VERDICT: PASS

Code + contract test + e2e direct đã PASS. 2 root cause đã fix:
1. `createBypassRequest` gửi raw Buffer thay vì `JSON.stringify(Buffer)` (root cause 429)
2. `resolveModelAlias` regex match cả `-max` lẫn `-max-1m` (passthrough bug)

**Việc còn lại cho user:**
1. Bật MITM toggle qua UI 9router (dashboard → MITM → enable)
2. Test e2e với Devin CLI thật qua MITM full pipeline
3. Commit + push sau khi e2e pass
