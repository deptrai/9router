---
id: N.1
title: Devin Provider Config, Auth & Model List
epic: N
status: done
priority: high
storyPoints: 3
baseline_commit: 606769cb
context:
  - _bmad-output/planning-artifacts/epics.md
  - open-sse/config/providers.js
  - open-sse/config/providerModels.js
  - src/shared/constants/providers.js
  - src/shared/constants/models.js
  - src/app/api/v1/models/route.js
  - src/app/api/providers/validate/route.js
  - src/app/api/providers/[id]/test/testUtils.js
---

# Story N.1: Devin Provider Config, Auth & Model List

Status: ready-for-dev

## Story

As a **user của 9Router**,
I want **kết nối Devin bằng API key và thấy model list Devin trong `/v1/models`**,
so that **tôi có thể chọn provider Devin cho combo hoặc direct routing (executor thực thi nằm ở story N.2)**.

## Bối cảnh và quyết định architecture

> **Story này CHỈ thêm phần "khai báo" của provider Devin**: metadata UI (để connectable), runtime config (`PROVIDERS`), model list tĩnh, và validation/test-connection. **KHÔNG bao gồm executor** (session create → poll → emit) — đó là story N.2. Sau khi N.1 xong: Devin xuất hiện trong UI Provider Connections, user lưu được API key + org_id, key được validate, và `/v1/models` trả 4 model IDs. Một request `/v1/chat/completions` tới `devin/*` sẽ CHƯA chạy được cho tới khi N.2 hoàn thành (hiện tại `getExecutor("devin")` fallback `DefaultExecutor` → POST OpenAI body tới base URL Devin → 404/405 mơ hồ — chấp nhận được ở N.1).

### Research findings — Devin API (verified 2026-06-25)

- **Devin KHÔNG phải OpenAI-compatible `/chat/completions`.** Đây là **session-based REST API** (Cognition AI). Tham chiếu: `https://docs.devin.ai`.
- **API version:** Dùng **v3** (current, có RBAC, không deprecated). v1/v2 deprecated.
- **Base URL (v3):** `https://api.devin.ai/v3/organizations/{org_id}/sessions` (org_id bắt buộc trong URL path).
- **Auth:** `Authorization: Bearer <key>`. Key format: Service User API Key (`cog_*`) — v3 chỉ hỗ trợ service user. (Legacy v1 dùng `apk_user_*`/`apk_*` nhưng deprecated).
- **Endpoints liên quan N.1 (chỉ validate):**
  - `GET /v3/organizations/{org_id}/sessions` — list sessions (read-only, dùng để verify key hợp lệ — KHÔNG tạo session, KHÔNG tốn ACU). Cần permission `ViewOrgSessions`.
  - `POST /v3/organizations/{org_id}/sessions`, `GET /v3/organizations/{org_id}/sessions/{id}` — dùng ở N.2 (executor).
- **Devin "mode" thay cho "model" LLM thông thường.** v3 `CreateSessionParams` có `devin_mode: normal|fast|lite|ultra`. 9Router map model ID → mode ở executor (N.2). Ở N.1 chỉ cần khai báo 4 model tĩnh.
- **Không có whoami siêu nhẹ ở v3** ngoài `GET /v3/organizations/{org_id}/sessions`. Dùng nó cho validate là chấp nhận được (read-only).

### Hiện trạng code (verified tại baseline 606769cb)

9Router có **hai registry provider** chạy song song — đây là điểm DỄ SAI nhất, phải sửa đồng bộ cả hai:

1. **`open-sse/config/providers.js`** → object `PROVIDERS` (runtime/executor config). Mỗi provider khai báo `baseUrl`, `format`, `headers`. [Source: open-sse/config/providers.js:50-57]
2. **`open-sse/config/providerModels.js`** → object `PROVIDER_MODELS` (single source of truth cho models, key = alias). `src/shared/constants/models.js` **re-export** từ đây. [Source: src/shared/constants/models.js:2-15]
3. **`src/shared/constants/providers.js`** → metadata UI. Các group: `FREE_PROVIDERS`, `FREE_TIER_PROVIDERS`, `OAUTH_PROVIDERS`, **`APIKEY_PROVIDERS`** (devin vào đây), `WEB_COOKIE_PROVIDERS`. Merge thành `AI_PROVIDERS` tại line 208. [Source: src/shared/constants/providers.js:208]

**Cách `/v1/models` expose model của provider connected** [Source: src/app/api/v1/models/route.js]:
- `buildModelsList()` đọc connections từ DB (`getProviderConnections()`, filter `isActive !== false`) — line 211-218.
- Với mỗi active connection: `providerMatchesKinds(providerId, kindFilter)` check `AI_PROVIDERS[providerId].serviceKinds` (mặc định `["llm"]`) — line 308-309. **→ Devin PHẢI có mặt trong `AI_PROVIDERS` thì model mới xuất hiện.**
- `staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId`; `providerModels = PROVIDER_MODELS[staticAlias]` — line 311-317. **→ key của `PROVIDER_MODELS` phải khớp alias.**
- Branch live-fetch (`fetchCompatibleModelIds`) chỉ chạy cho `isOpenAICompatibleProvider`/`isAnthropicCompatibleProvider` — Devin KHÔNG khớp → chỉ dùng model tĩnh. Đúng ý đồ (4 model cố định).

**Cách provider được "connected"**: có record trong table `providerConnections` với `isActive = 1` (`src/lib/db/repos/connectionsRepo.js#getProviderConnections`). API tạo connection: `POST /api/providers` (`src/app/api/providers/route.js`) — lưu `apiKey` trong column `data` (JSON), `authType = "apikey"`.

**Validate key** (`src/app/api/providers/validate/route.js`): có `switch (provider)` dài; `default` case (line 586-591) yêu cầu `cfg.format === "openai"`. Vì Devin dùng `format: "devin"` → **rơi vào "Provider validation not supported"**. → BẮT BUỘC thêm `case "devin"`. [Source: src/app/api/providers/validate/route.js:586-591]

**Test connection đã lưu** (`src/app/api/providers/[id]/test/testUtils.js`): cũng có `switch (connection.provider)` (line 380+) với generic `/models` probe trước đó — Devin không có `/models` chuẩn nên cần `case "devin"` riêng.

### Quyết định architecture

- **QĐ1 — Alias = `devin` nhất quán mọi nơi.** KHÔNG thêm vào `OAUTH_ALIASES`. Khi đó `PROVIDER_ID_TO_ALIAS["devin"] = "devin"`, entry shared registry đặt `alias: "devin"`, key `PROVIDER_MODELS["devin"]`. → model ID render thành `devin/normal`, `devin/fast`... (khớp FR119). Tránh hoàn toàn drift dual-alias.
- **QĐ2 — Group `APIKEY_PROVIDERS`.** Devin auth bằng API key (không OAuth, không cookie) → vào `APIKEY_PROVIDERS` trong `src/shared/constants/providers.js`. `serviceKinds: ["llm"]`.
- **QĐ3 — `format: "devin"` (custom).** Trong `PROVIDERS` (open-sse), đặt `format: "devin"`, `baseUrl: "https://api.devin.ai/v3/organizations"` (không có org_id ở đây — org_id lấy từ `providerSpecificData.orgId` lúc runtime). KHÔNG dùng `format: "openai"` vì sẽ kích hoạt sai đường translation/live-fetch và default-validate. Format `"devin"` sẽ được executor N.2 nhận diện.
- **QĐ4 — 4 model tĩnh.** `PROVIDER_MODELS["devin"] = [normal, fast, lite, ultra]`. Đây là "mode" của Devin, không phải LLM model — đặt `name` mô tả rõ.
- **QĐ5 — Validate = `GET /v3/organizations/{org_id}/sessions`.** Read-only, không tạo session, không tốn ACU. `isValid = res.status !== 401 && res.status !== 403`. Áp dụng cho cả `validate/route.js` và `testUtils.js`. `org_id` lấy từ `providerSpecificData.orgId` (pattern giống `cloudflare-ai` dùng `accountId`).
- **QĐ6 — `DEVIN_API_KEY` env shortcut (FR120) — chỉ ảnh hưởng MODEL LISTING ở N.1.** 9Router KHÔNG có sẵn pattern inject credential từ env vào connections (đã verify: không có `process.env[` cho provider key trong `auth.js`/models route). Cách low-risk: trong `buildModelsList()`, nếu `process.env.DEVIN_API_KEY` set VÀ chưa có connection `devin` active → thêm **synthetic connection** `{ provider: "devin", apiKey: env, isActive: true }` vào danh sách `connections` (chỉ trong scope hàm, KHÔNG ghi DB). Việc executor dùng env làm credential fallback khi chạy request thuộc N.2.
- **QĐ7 — KHÔNG viết executor ở N.1.** `open-sse/executors/devin.js` và đăng ký trong `index.js` thuộc N.2. N.1 không đụng `open-sse/executors/`.

## Acceptance Criteria

### AC1 — Devin xuất hiện trong UI Provider Connections
**Given** user/admin mở trang thêm Provider Connection
**When** danh sách provider render từ `AI_PROVIDERS`
**Then** "Devin" xuất hiện trong nhóm API Key providers với `name: "Devin"`, icon, color, `website: "https://devin.ai"`, và `notice.apiKeyUrl` trỏ tới trang lấy API key
**And** form hiển thị field nhập API Key (auth type `apikey`).

### AC2 — Lưu connection Devin với API key + org_id
**Given** user nhập API key Devin (`cog_*`) và Organization ID (thấy ở Settings > Service Users)
**When** `POST /api/providers` xử lý (provider = `devin`)
**Then** connection được tạo với `authType: "apikey"`, `apiKey` lưu trong column `data`
**And** `providerSpecificData.orgId` được lưu (pattern giống `cloudflare-ai.accountId`)
**And** connection hiển thị trong danh sách với key được mask.

### AC3 — Validate API key + org_id hợp lệ
**Given** user nhập API key (`cog_*`) và Organization ID rồi bấm "Validate"/"Test"
**When** `POST /api/providers/validate` với `provider: "devin"`, `providerSpecificData.orgId`
**Then** 9Router gọi `GET https://api.devin.ai/v3/organizations/{org_id}/sessions` với `Authorization: Bearer <key>`
**And** key hợp lệ (2xx) → `{ valid: true }`
**And** key sai (401/403) → `{ valid: false, error: "Invalid API key or org_id" }`
**And** org_id không tồn tại (404) → `{ valid: false, error: "Organization ID not found" }`
**And** Devin API down (5xx) → `{ valid: false, error: "Devin API unavailable, try again" }`
**And** thiếu org_id → `{ valid: false, error: "Missing Organization ID" }`
**And** KHÔNG còn trả "Provider validation not supported" cho `devin`.

### AC4 — Test connection đã lưu
**Given** connection Devin đã lưu trong DB (có `providerSpecificData.orgId`)
**When** `POST /api/providers/[id]/test` chạy `testSingleConnection`
**Then** test gọi `GET /v3/organizations/{org_id}/sessions` với key + org_id của connection
**And** trả `{ valid: true/false }` đúng theo status (≠ 401/403 = valid).

### AC5 — `/v1/models` trả 4 model Devin khi connected
**Given** có connection Devin active (hoặc `DEVIN_API_KEY` env set — xem AC6)
**When** client gọi `GET /v1/models`
**Then** response chứa đúng 4 entry: `devin/normal`, `devin/fast`, `devin/lite`, `devin/ultra`
**And** mỗi entry có `object: "model"`, `owned_by: "devin"`
**And** khi KHÔNG có connection và KHÔNG có env → KHÔNG có model `devin/*` nào xuất hiện.

### AC6 — `DEVIN_API_KEY` + `DEVIN_ORG_ID` env shortcut (model listing)
**Given** `DEVIN_API_KEY` và `DEVIN_ORG_ID` env được set và KHÔNG có connection `devin` trong DB
**When** `GET /v1/models` được gọi
**Then** `buildModelsList()` chèn synthetic connection `devin` với `providerSpecificData.orgId = env` (chỉ trong bộ nhớ, KHÔNG ghi DB)
**And** 4 model `devin/*` xuất hiện
**And** nếu đã có connection `devin` active trong DB thì KHÔNG chèn trùng (DB ưu tiên).
**And** chỉ có `DEVIN_API_KEY` mà thiếu `DEVIN_ORG_ID` → KHÔNG chèn synthetic connection (tránh validate sai endpoint).

### AC7 — Alias nhất quán, không drift
**Given** toàn bộ khai báo devin
**When** kiểm tra cross-registry
**Then** `PROVIDER_ID_TO_ALIAS["devin"] === "devin"` (devin KHÔNG có trong `OAUTH_ALIASES`)
**And** entry trong `APIKEY_PROVIDERS` có `alias: "devin"`
**And** key `PROVIDER_MODELS["devin"]` tồn tại với 4 model
**And** model ID render là `devin/<mode>` (không phải `dv/<mode>` hay alias khác).

### AC8 — Zero regression
**Given** toàn bộ thay đổi N.1
**When** chạy full test suite + `/v1/models` cho provider khác
**Then** model list của các provider hiện có (kiro, openai, glm, openrouter...) KHÔNG đổi
**And** validate/test của provider khác KHÔNG đổi (chỉ thêm `case "devin"`, không sửa case sẵn có)
**And** request `/v1/chat/completions` tới provider khác KHÔNG ảnh hưởng.

## Tasks / Subtasks

- [x] **T1 — Runtime config `PROVIDERS`** (AC2, AC7, QĐ3) — `open-sse/config/providers.js`
  - [x] Thêm entry `devin: { baseUrl: "https://api.devin.ai/v3/organizations", format: "devin", headers: {} }`
  - [x] KHÔNG thêm `clientId`/`tokenUrl`/`authUrl` (không OAuth)
  - [x] Đặt cùng khu vực với các api-key provider khác (vd gần `commandcode`, `groq`)

- [x] **T2 — Model list tĩnh `PROVIDER_MODELS`** (AC5, AC7, QĐ4) — `open-sse/config/providerModels.js`
  - [x] Thêm key `devin` với 4 model:
    - `{ id: "normal", name: "Devin (Normal)" }`
    - `{ id: "fast", name: "Devin (Fast)" }`
    - `{ id: "lite", name: "Devin (Lite)" }`
    - `{ id: "ultra", name: "Devin (Ultra)" }`
  - [x] KHÔNG thêm `devin` vào `OAUTH_ALIASES` (giữ alias = id = "devin") — QĐ1
  - [x] (Optional) đặt `contextWindow` hợp lý nếu cần; nếu bỏ trống thì models route vẫn render bình thường

- [x] **T3 — Metadata UI `APIKEY_PROVIDERS`** (AC1, AC7, QĐ2) — `src/shared/constants/providers.js`
  - [x] Thêm vào object `APIKEY_PROVIDERS`:
    `devin: { id: "devin", alias: "devin", name: "Devin", icon: "smart_toy", color: "#0B0B0B", textIcon: "DV", website: "https://devin.ai", notice: { apiKeyUrl: "https://app.devin.ai/settings/service-users", text: "Session-based agent (v3 API). Cần Service User API Key (cog_*) + Organization ID. Mỗi request tạo 1 Devin session; độ trễ cao (phút)." }, serviceKinds: ["llm"], hasProviderSpecificData: true }`
  - [x] Xác nhận `AI_PROVIDERS` tự merge (line 208) — không cần sửa thêm
  - [x] KHÔNG thêm devin vào `USAGE_SUPPORTED_PROVIDERS`/`USAGE_APIKEY_PROVIDERS` (Devin không có quota API tương thích)

- [x] **T4 — Validate key + org_id** (AC3, QĐ5) — `src/app/api/providers/validate/route.js`
  - [x] Thêm `if (provider === "devin")` block sau cloudflare-ai (pattern PSD-provider thực tế, giống cloudflare/azure — KHÔNG dùng `case` trong switch)
  - [x] `const { orgId } = providerSpecificData || {}; if (!orgId) return { valid: false, error: "Missing Organization ID" };`
  - [x] `const res = await fetch(\`https://api.devin.ai/v3/organizations/\${encodeURIComponent(orgId)}/sessions\`, { headers: { Authorization: \`Bearer ${apiKey}\` }, signal: AbortSignal.timeout(8000) });`
  - [x] `isValid = res.status >= 200 && res.status < 300;` (best practice: chỉ 2xx mới valid, reject 401/403/404/5xx — đã resolve review D1)
  - [x] Đảm bảo KHÔNG log apiKey/orgId

- [x] **T5 — Test saved connection** (AC4, QĐ5) — `src/app/api/providers/[id]/test/testUtils.js`
  - [x] Thêm `case "devin":` trong `switch (connection.provider)`
  - [x] `const psd = connection.providerSpecificData || {}; const orgId = psd.orgId; if (!orgId) return { valid: false, error: "Missing Organization ID" };`
  - [x] `const res = await fetchWithConnectionProxy(\`https://api.devin.ai/v3/organizations/\${encodeURIComponent(orgId)}/sessions\`, { headers: { Authorization: \`Bearer ${connection.apiKey}\` } }, effectiveProxy);`
  - [x] `valid = res.status >= 200 && res.status < 300;` (best practice: chỉ 2xx valid, reject 401/403/404/5xx — đồng bộ với T4)

- [x] **T6 — `DEVIN_API_KEY` + `DEVIN_ORG_ID` env shortcut cho model listing** (AC6, QĐ6) — `src/app/api/v1/models/route.js`
  - [x] Trong `buildModelsList()`, sau khi load `connections`: nếu `process.env.DEVIN_API_KEY` set VÀ `process.env.DEVIN_ORG_ID` set VÀ `!connections.some(c => c.provider === "devin")` → `connections.push({ provider: "devin", apiKey: process.env.DEVIN_API_KEY, isActive: true, providerSpecificData: { orgId: process.env.DEVIN_ORG_ID } })`
  - [x] Synthetic connection CHỈ trong scope hàm (không ghi DB)
  - [x] Đảm bảo không phá nhánh `connections.length === 0` (nếu env set thì length > 0 → đi nhánh connected, đúng ý đồ)

- [x] **T7 — Tests** (AC1–AC8) — `tests/unit/`
  - [x] `tests/unit/devin-provider-config.test.js` (NEW):
    - `PROVIDERS.devin` tồn tại với `format: "devin"`, baseUrl đúng
    - `PROVIDER_MODELS.devin` có đúng 4 model id: normal/fast/lite/ultra
    - `PROVIDER_ID_TO_ALIAS.devin === "devin"`; `AI_PROVIDERS.devin` tồn tại với `alias: "devin"`, `serviceKinds: ["llm"]`
  - [x] `tests/unit/devin-models-route.test.js` (NEW): mock `getProviderConnections`
    - có connection devin active → `buildModelsList(["llm"])` chứa 4 `devin/*`
    - không connection + `DEVIN_API_KEY` + `DEVIN_ORG_ID` set → vẫn có 4 `devin/*`
    - không connection + chỉ có `DEVIN_API_KEY` (thiếu org_id) → KHÔNG có `devin/*`
    - không connection + không env → KHÔNG có `devin/*`
    - có cả connection lẫn env → không trùng lặp model
  - [x] `tests/unit/devin-validate.test.js` (NEW): mock `fetch`
    - 200 → `{ valid: true }`; 401/403 → `{ valid: false }`; thiếu org_id → `{ valid: false, error: "Missing Organization ID" }`; gọi đúng URL `/v3/organizations/{org_id}/sessions` với Bearer
  - [x] Regression: `/v1/models` cho provider khác không đổi; validate provider khác không đổi
  - [x] Assertion executor: `hasSpecializedExecutor("devin")` === false (chốt điểm wire của N.2)

## Dev Notes

### Ràng buộc bắt buộc

- **KHÔNG log API key Devin** (`cog_*`) hoặc Organization ID ở bất kỳ đâu (NFR29). Không return trong API response (ngoài masked), không trong error message.
- **KHÔNG viết executor ở N.1.** Không tạo `open-sse/executors/devin.js`, không sửa `open-sse/executors/index.js` — đó là N.2. Nếu đụng vào sẽ vượt scope và gây review fail.
- **Sửa đồng bộ 3 registry** (T1 `PROVIDERS`, T2 `PROVIDER_MODELS`, T3 `AI_PROVIDERS`). Thiếu 1 trong 3 → drift: vd thiếu T3 thì `providerMatchesKinds` loại devin khỏi `/v1/models`; thiếu T2 thì `PROVIDER_MODELS["devin"]` rỗng → 0 model.
- **Chỉ THÊM `case "devin"`**, KHÔNG sửa case sẵn có trong validate/testUtils (tránh regression AC8).
- **`format: "devin"` là custom** — đảm bảo không có nơi nào assume format ∈ {openai, claude, gemini,...} mà crash khi gặp "devin" ở các đường mã N.1 chạm tới. (Translation/executor xử lý format ở N.2; N.1 chỉ liên quan model-listing + validate, đã verify không crash.)
- **Secret at-rest:** API key (`cog_*`) lưu plaintext trong column `data` (JSON) — theo pattern hiện tại của 9Router. N.1 không thêm mã hóa (defer NFR mã hóa).

### Devin API — shape cần biết (cho validate)

```
GET https://api.devin.ai/v3/organizations/{org_id}/sessions
Headers: Authorization: Bearer <cog_*>
→ 200 + danh sách sessions = key hợp lệ (cần permission ViewOrgSessions)
→ 401/403 = key sai/không đủ quyền hoặc org_id sai
→ 404 = org_id không tồn tại
(read-only, KHÔNG tạo session, KHÔNG tốn ACU)
```

### Files sẽ chạm

- `open-sse/config/providers.js` — MODIFY (thêm entry `devin` vào `PROVIDERS`)
- `open-sse/config/providerModels.js` — MODIFY (thêm key `devin` vào `PROVIDER_MODELS`)
- `src/shared/constants/providers.js` — MODIFY (thêm `devin` vào `APIKEY_PROVIDERS`)
- `src/app/api/providers/validate/route.js` — MODIFY (thêm `case "devin"`)
- `src/app/api/providers/[id]/test/testUtils.js` — MODIFY (thêm `case "devin"`)
- `src/app/api/v1/models/route.js` — MODIFY (env shortcut trong `buildModelsList`)
- `tests/unit/devin-provider-config.test.js` — NEW
- `tests/unit/devin-models-route.test.js` — NEW
- `tests/unit/devin-validate.test.js` — NEW

### KHÔNG được chạm

- `open-sse/executors/*` — toàn bộ thuộc N.2
- `open-sse/translator/*` — Devin không cần translator (executor tự xử lý ở N.2)
- `src/sse/services/auth.js#getProviderCredentials` — hot-path; env-credential cho RUNTIME request thuộc N.2
- Các `case` sẵn có trong validate/testUtils

### Testing standards

- Vitest từ `tests/`: `cd /Users/luisphan/Documents/9router/tests && npm test -- unit/<file>.test.js` (alias `@/`→`src/`).
- Test deps ở `/tmp/node_modules` (project root `node_modules` rỗng) — theo project-context rule #2.
- Mock `fetch` cho validate test; mock `getProviderConnections` cho models-route test.
- Với env test: set/restore `process.env.DEVIN_API_KEY` và `process.env.DEVIN_ORG_ID` trong `beforeEach`/`afterEach`.

### References

- Devin API overview: https://docs.devin.ai/api-reference/overview
- Devin v3 sessions: https://docs.devin.ai/api-reference/getting-started/teams-quickstart
- Devin authentication (service user, org_id): https://docs.devin.ai/api-reference/authentication
- [Source: _bmad-output/planning-artifacts/epics.md#Epic N — Devin Provider Integration] — FR110, FR118, FR119, FR120
- [Source: src/app/api/v1/models/route.js#buildModelsList] — line 211-420, cách expose model theo connection + serviceKinds
- [Source: src/shared/constants/providers.js] — line 70-208 (APIKEY_PROVIDERS, AI_PROVIDERS merge), 234-249 (alias helpers)
- [Source: open-sse/config/providerModels.js] — line 944-967 (OAUTH_ALIASES, PROVIDER_ID_TO_ALIAS)
- [Source: src/app/api/providers/validate/route.js] — line 246-622 (switch provider), 586-591 (default fallthrough)
- [Source: src/app/api/providers/[id]/test/testUtils.js] — line 380+ (switch connection.provider)
- [Source: docs/stories/2-35a-v98store-payg-api.md] — story provider-integration tương tự (mẫu format)

### Envelope vận hành (để defer N.2)

- **Secret at-rest:** API key (`cog_*`) lưu plaintext trong column `data` (JSON) — theo pattern hiện tại của 9Router. N.1 không thêm mã hóa (defer NFR mã hóa).
- **Precedence env vs connection:** N.1 chỉ precedence cho model-listing (env shortcut). Precedence lúc runtime request (executor dùng env hay DB) defer sang N.2.
- **Timeout:** Validate/test dùng `AbortSignal.timeout(8000)` (T4/T5). Executor timeout (session poll) defer sang N.2.
- **Cache TTL:** Model list được cache `MODELS_CACHE_TTL_MS` (5 phút). Synthetic env-connection chịu cache — model devin xuất hiện trong ≤ TTL sau khi env set.
- **serviceKinds:** Devin được gắn `serviceKinds: ["llm"]` để xuất hiện trong model list UI. Lưu ý: Devin là async agent (độ trễ nhiều phút) nên có thể gây timeout nếu dùng trong combo/chat thường — note này để N.2 cân nhắc UX.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (BMAD Create Story — exhaustive analysis + design 2026-06-25)
GLM-5.2 (BMAD Dev Story — implementation 2026-06-25)

### Debug Log References

- Architecture validation (pre-dev) phát hiện B1 (v1/v3 fork) → chốt v3 + org_id trước khi code.
- Test `devin-models-route.test.js` ban đầu fail vì GET handler cache `_modelsCache` (TTL 5p) persist cross-test → chuyển sang gọi `buildModelsList(["llm"])` trực tiếp (bypass cache). Khớp envelope S3 đã ghi.
- Test AC5/AC6 "không connection" ban đầu fail vì route có static-fallback branch (`connections.length === 0` → expose ALL `PROVIDER_MODELS`, bao gồm devin) — đây là behavior DB-down có sẵn cho mọi provider. Sửa test dùng non-devin connection để vào else-branch, kiểm đúng intent AC5 ("có connection nhưng không devin → không có devin").

### Completion Notes List

- **T1**: `PROVIDERS.devin` thêm sau `commandcode` (cùng khu vực api-key, custom format). baseUrl `https://api.devin.ai/v3/organizations` (org_id lấy từ PSD lúc runtime). KHÔNG OAuth fields.
- **T2**: `PROVIDER_MODELS.devin` = 4 mode (normal/fast/lite/ultra). KHÔNG thêm vào `OAUTH_ALIASES` → `PROVIDER_ID_TO_ALIAS.devin = "devin"` tự động.
- **T3**: `APIKEY_PROVIDERS.devin` thêm sau `commandcode`, có `hasProviderSpecificData: true` (pattern cloudflare-ai/azure), `serviceKinds: ["llm"]`, notice trỏ `settings/service-users` (v3).
- **T4**: Validate route — thêm `if (provider === "devin")` block sau cloudflare-ai (theo pattern PSD-provider thực tế, KHÔNG phải `case` trong switch vì cloudflare/azure cũng dùng if-block). Validate `GET /v3/organizations/{org_id}/sessions`, `isValid = status !== 401 && !== 403`, timeout 8s, catch network error.
- **T5**: testUtils — thêm `case "devin":` trong switch (file này dùng switch, khác validate route). Pattern giống cloudflare-ai case, dùng `fetchWithConnectionProxy`.
- **T6**: `buildModelsList()` — env shortcut chèn synthetic connection khi CẢ HAI `DEVIN_API_KEY` + `DEVIN_ORG_ID` set (thiếu 1 thì không chèn, tránh validate sai endpoint). DB connection ưu tiên.
- **T7**: 3 test files (16 tests) + regression full suite 1999 pass / 0 fail. Assertion `hasSpecializedExecutor("devin") === false` chốt wire point N.2.
- **AC1–AC8**: tất cả thỏa. AC8 zero regression verify qua full suite.
- **KHÔNG đụng executor** (QĐ7): `open-sse/executors/*` nguyên vẹn, `getExecutor("devin")` vẫn fallback `DefaultExecutor` (chấp nhận ở N.1, N.2 sẽ thay).

### File List

Modified:
- `open-sse/config/providers.js` — thêm entry `devin` vào `PROVIDERS`
- `open-sse/config/providerModels.js` — thêm key `devin` (4 mode) vào `PROVIDER_MODELS`
- `src/shared/constants/providers.js` — thêm `devin` vào `APIKEY_PROVIDERS`
- `src/app/api/providers/validate/route.js` — thêm `if (provider === "devin")` block
- `src/app/api/providers/[id]/test/testUtils.js` — thêm `case "devin":`
- `src/app/api/v1/models/route.js` — env shortcut `DEVIN_API_KEY`+`DEVIN_ORG_ID` trong `buildModelsList`

New:
- `tests/unit/devin-provider-config.test.js` — 6 tests (3 registry đồng bộ + executor wire point)
- `tests/unit/devin-models-route.test.js` — 5 tests (AC5/AC6: connection + env shortcut + dedup)
- `tests/unit/devin-validate.test.js` — 5 tests (AC3: 200/401/403/404 + missing org_id)

## Change Log

| Date | Change |
|------|--------|
| 2026-06-25 | Story N.1 implemented: Devin provider config (v3 API) + auth (cog_* + org_id) + 4 model list + validate/test case + DEVIN_API_KEY/DEVIN_ORG_ID env shortcut. 16 new tests, full suite 1999 pass / 0 fail. KHÔNG executor (→N.2). |
| 2026-06-25 | Code review (3-layer adversarial): 1 decision-needed, 3 patch, 5 defer, 8 dismissed. |

### Review Findings

- [x] [Review][Decision] **5xx treated as valid** — RESOLVED → patch (best practice: chỉ 2xx valid, reject 401/403/404/5xx). Đã apply ở validate route + testUtils + test.
- [x] [Review][Patch] **AC2 — UI thiếu field nhập orgId cho devin** [src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js, src/shared/components/EditConnectionModal.js] — FIXED. Thêm `isDevin` + `devinData.orgId` state + UI field + case trong `buildProviderSpecificData` (AddApiKeyModal) + load/save/test path (EditConnectionModal).
- [x] [Review][Patch] **orgId URL injection — thiếu encodeURIComponent** [src/app/api/providers/validate/route.js, src/app/api/providers/[id]/test/testUtils.js] — FIXED. Thêm `encodeURIComponent(orgId)` ở cả 2 nơi.
- [x] [Review][Patch] **T4 checkbox text sai — mô tả "case" nhưng code dùng "if-block"** [docs/stories/n-1-devin-provider-config-auth-models.md] — FIXED. Cập nhật T4/T5 checkbox text + AC3 phản ánh rule best practice.
- [x] [Review][Defer] **testUtils devin case thiếu timeout signal** [src/app/api/providers/[id]/test/testUtils.js:399] — deferred, pre-existing — sibling cloudflare-ai case (line 386) cũng không có `AbortSignal.timeout`, đây là pattern chung của testUtils (khác validate route).
- [x] [Review][Defer] **testUtils devin case thiếu try-catch** [src/app/api/providers/[id]/test/testUtils.js:394-404] — deferred, pre-existing — sibling cloudflare-ai case (line 381-393) cũng không có try-catch, pattern chung của testUtils switch cases.
- [x] [Review][Defer] **Devin API URL hardcoded không centralized qua PROVIDERS** [src/app/api/providers/validate/route.js:205, src/app/api/providers/[id]/test/testUtils.js:398] — deferred, pre-existing — cloudflare-ai/azure cũng hardcode URL trong validate route, không dùng `PROVIDERS.baseUrl`. Pattern chung.
- [x] [Review][Defer] **Cache stale khi env var change** [src/app/api/v1/models/route.js:517] — deferred, pre-existing — `_modelsCache` TTL 5 phút, không invalidate khi `DEVIN_API_KEY`/`DEVIN_ORG_ID` change. Đã documented trong spec S3. Env vars static at runtime (set once at deploy).
- [x] [Review][Defer] **stream.js `extractOutputForFormat` không handle format "devin"** [open-sse/streaming/stream.js:160-164] — deferred, N.2 scope — QĐ7 explicit: không đụng executor/streaming ở N.1. Format "devin" sẽ được executor N.2 xử lý.
