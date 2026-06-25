---
id: N.1
title: Devin Provider Config, Auth & Model List
epic: N
status: ready-for-dev
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

> **Story này CHỈ thêm phần "khai báo" của provider Devin**: metadata UI (để connectable), runtime config (`PROVIDERS`), model list tĩnh, và validation/test-connection. **KHÔNG bao gồm executor** (session create → poll → emit) — đó là story N.2. Sau khi N.1 xong: Devin xuất hiện trong UI Provider Connections, user lưu được API key, key được validate, và `/v1/models` trả 4 model IDs. Một request `/v1/chat/completions` tới `devin/*` sẽ CHƯA chạy được cho tới khi N.2 hoàn thành (sẽ trả lỗi "no executor" — chấp nhận được ở N.1).

### Research findings — Devin API (verified 2026-06-25)

- **Devin KHÔNG phải OpenAI-compatible `/chat/completions`.** Đây là **session-based REST API** (Cognition AI). Tham chiếu: `https://docs.devin.ai`.
- **Base URL (v1 API):** `https://api.devin.ai/v1`
- **Auth:** `Authorization: Bearer <key>`. Key format: Personal API Key (`apk_user_*`), Service API Key (`apk_*`), hoặc service user v3 (`cog_*`).
- **Endpoints liên quan N.1 (chỉ validate):**
  - `GET /v1/sessions` — list sessions (read-only, dùng để verify key hợp lệ — KHÔNG tạo session, KHÔNG tốn ACU)
  - `POST /v1/sessions`, `GET /v1/sessions/{id}` — dùng ở N.2 (executor)
- **Devin "mode" thay cho "model" LLM thông thường.** v1 `CreateSessionParams` không nhận mode trực tiếp; v3 có `devin_mode: normal|fast|lite|ultra`. 9Router map model ID → mode ở executor (N.2). Ở N.1 chỉ cần khai báo 4 model tĩnh.
- **Không có whoami siêu nhẹ ở v1** ngoài `GET /v1/sessions`. Dùng nó cho validate là chấp nhận được (read-only).

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
- **QĐ3 — `format: "devin"` (custom).** Trong `PROVIDERS` (open-sse), đặt `format: "devin"`, `baseUrl: "https://api.devin.ai/v1"`. KHÔNG dùng `format: "openai"` vì sẽ kích hoạt sai đường translation/live-fetch và default-validate. Format `"devin"` sẽ được executor N.2 nhận diện.
- **QĐ4 — 4 model tĩnh.** `PROVIDER_MODELS["devin"] = [normal, fast, lite, ultra]`. Đây là "mode" của Devin, không phải LLM model — đặt `name` mô tả rõ.
- **QĐ5 — Validate = `GET /v1/sessions`.** Read-only, không tạo session, không tốn ACU. `isValid = res.status !== 401 && res.status !== 403`. Áp dụng cho cả `validate/route.js` và `testUtils.js`.
- **QĐ6 — `DEVIN_API_KEY` env shortcut (FR120) — chỉ ảnh hưởng MODEL LISTING ở N.1.** 9Router KHÔNG có sẵn pattern inject credential từ env vào connections (đã verify: không có `process.env[` cho provider key trong `auth.js`/models route). Cách low-risk: trong `buildModelsList()`, nếu `process.env.DEVIN_API_KEY` set VÀ chưa có connection `devin` active → thêm **synthetic connection** `{ provider: "devin", apiKey: env, isActive: true }` vào danh sách `connections` (chỉ trong scope hàm, KHÔNG ghi DB). Việc executor dùng env làm credential fallback khi chạy request thuộc N.2.
- **QĐ7 — KHÔNG viết executor ở N.1.** `open-sse/executors/devin.js` và đăng ký trong `index.js` thuộc N.2. N.1 không đụng `open-sse/executors/`.

## Acceptance Criteria

### AC1 — Devin xuất hiện trong UI Provider Connections
**Given** user/admin mở trang thêm Provider Connection
**When** danh sách provider render từ `AI_PROVIDERS`
**Then** "Devin" xuất hiện trong nhóm API Key providers với `name: "Devin"`, icon, color, `website: "https://devin.ai"`, và `notice.apiKeyUrl` trỏ tới trang lấy API key
**And** form hiển thị field nhập API Key (auth type `apikey`).

### AC2 — Lưu connection Devin với API key
**Given** user nhập API key Devin và submit
**When** `POST /api/providers` xử lý (provider = `devin`)
**Then** connection được tạo với `authType: "apikey"`, `apiKey` lưu trong column `data`
**And** connection hiển thị trong danh sách với key được mask.

### AC3 — Validate API key hợp lệ
**Given** user nhập API key và bấm "Validate"/"Test"
**When** `POST /api/providers/validate` với `provider: "devin"`
**Then** 9Router gọi `GET https://api.devin.ai/v1/sessions` với `Authorization: Bearer <key>`
**And** key hợp lệ (status ≠ 401/403) → `{ valid: true }`
**And** key sai (401/403) → `{ valid: false, error: "Invalid API key" }`
**And** KHÔNG còn trả "Provider validation not supported" cho `devin`.

### AC4 — Test connection đã lưu
**Given** connection Devin đã lưu trong DB
**When** `POST /api/providers/[id]/test` chạy `testSingleConnection`
**Then** test gọi `GET /v1/sessions` với key của connection
**And** trả `{ valid: true/false }` đúng theo status (≠ 401/403 = valid).

### AC5 — `/v1/models` trả 4 model Devin khi connected
**Given** có connection Devin active (hoặc `DEVIN_API_KEY` env set — xem AC6)
**When** client gọi `GET /v1/models`
**Then** response chứa đúng 4 entry: `devin/normal`, `devin/fast`, `devin/lite`, `devin/ultra`
**And** mỗi entry có `object: "model"`, `owned_by: "devin"`
**And** khi KHÔNG có connection và KHÔNG có env → KHÔNG có model `devin/*` nào xuất hiện.

### AC6 — `DEVIN_API_KEY` env shortcut (model listing)
**Given** `DEVIN_API_KEY` env được set và KHÔNG có connection `devin` trong DB
**When** `GET /v1/models` được gọi
**Then** `buildModelsList()` chèn synthetic connection `devin` (chỉ trong bộ nhớ, KHÔNG ghi DB)
**And** 4 model `devin/*` xuất hiện
**And** nếu đã có connection `devin` active trong DB thì KHÔNG chèn trùng (DB ưu tiên).

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

- [ ] **T1 — Runtime config `PROVIDERS`** (AC2, AC7, QĐ3) — `open-sse/config/providers.js`
  - [ ] Thêm entry `devin: { baseUrl: "https://api.devin.ai/v1", format: "devin", headers: {} }`
  - [ ] KHÔNG thêm `clientId`/`tokenUrl`/`authUrl` (không OAuth)
  - [ ] Đặt cùng khu vực với các api-key provider khác (vd gần `commandcode`, `groq`)

- [ ] **T2 — Model list tĩnh `PROVIDER_MODELS`** (AC5, AC7, QĐ4) — `open-sse/config/providerModels.js`
  - [ ] Thêm key `devin` với 4 model:
    - `{ id: "normal", name: "Devin (Normal)" }`
    - `{ id: "fast", name: "Devin (Fast)" }`
    - `{ id: "lite", name: "Devin (Lite)" }`
    - `{ id: "ultra", name: "Devin (Ultra)" }`
  - [ ] KHÔNG thêm `devin` vào `OAUTH_ALIASES` (giữ alias = id = "devin") — QĐ1
  - [ ] (Optional) đặt `contextWindow` hợp lý nếu cần; nếu bỏ trống thì models route vẫn render bình thường

- [ ] **T3 — Metadata UI `APIKEY_PROVIDERS`** (AC1, AC7, QĐ2) — `src/shared/constants/providers.js`
  - [ ] Thêm vào object `APIKEY_PROVIDERS`:
    `devin: { id: "devin", alias: "devin", name: "Devin", icon: "smart_toy", color: "#0B0B0B", textIcon: "DV", website: "https://devin.ai", notice: { apiKeyUrl: "https://app.devin.ai/settings/api-keys", text: "Session-based agent. Mỗi request tạo 1 Devin session; độ trễ cao (phút). Cần API key apk_*/cog_*." }, serviceKinds: ["llm"] }`
  - [ ] Xác nhận `AI_PROVIDERS` tự merge (line 208) — không cần sửa thêm
  - [ ] KHÔNG thêm devin vào `USAGE_SUPPORTED_PROVIDERS`/`USAGE_APIKEY_PROVIDERS` (Devin không có quota API tương thích)

- [ ] **T4 — Validate key** (AC3, QĐ5) — `src/app/api/providers/validate/route.js`
  - [ ] Thêm `case "devin":` trong `switch (provider)` (trước `default`)
  - [ ] `const res = await fetch("https://api.devin.ai/v1/sessions", { headers: { Authorization: \`Bearer ${apiKey}\` }, signal: AbortSignal.timeout(8000) });`
  - [ ] `isValid = res.status !== 401 && res.status !== 403;`
  - [ ] Đảm bảo KHÔNG log apiKey

- [ ] **T5 — Test saved connection** (AC4, QĐ5) — `src/app/api/providers/[id]/test/testUtils.js`
  - [ ] Thêm `case "devin":` trong `switch (connection.provider)`
  - [ ] `const res = await fetchWithConnectionProxy("https://api.devin.ai/v1/sessions", { headers: { Authorization: \`Bearer ${connection.apiKey}\` } }, effectiveProxy);`
  - [ ] `isValid = res.status !== 401 && res.status !== 403;` (theo pattern các case khác trong file)

- [ ] **T6 — `DEVIN_API_KEY` env shortcut cho model listing** (AC6, QĐ6) — `src/app/api/v1/models/route.js`
  - [ ] Trong `buildModelsList()`, sau khi load `connections`: nếu `process.env.DEVIN_API_KEY` set VÀ `!connections.some(c => c.provider === "devin")` → `connections.push({ provider: "devin", apiKey: process.env.DEVIN_API_KEY, isActive: true, providerSpecificData: {} })`
  - [ ] Synthetic connection CHỈ trong scope hàm (không ghi DB)
  - [ ] Đảm bảo không phá nhánh `connections.length === 0` (nếu env set thì length > 0 → đi nhánh connected, đúng ý đồ)

- [ ] **T7 — Tests** (AC1–AC8) — `tests/unit/`
  - [ ] `tests/unit/devin-provider-config.test.js` (NEW):
    - `PROVIDERS.devin` tồn tại với `format: "devin"`, baseUrl đúng
    - `PROVIDER_MODELS.devin` có đúng 4 model id: normal/fast/lite/ultra
    - `PROVIDER_ID_TO_ALIAS.devin === "devin"`; `AI_PROVIDERS.devin` tồn tại với `alias: "devin"`, `serviceKinds: ["llm"]`
  - [ ] `tests/unit/devin-models-route.test.js` (NEW): mock `getProviderConnections`
    - có connection devin active → `buildModelsList(["llm"])` chứa 4 `devin/*`
    - không connection + `DEVIN_API_KEY` set → vẫn có 4 `devin/*`
    - không connection + không env → KHÔNG có `devin/*`
    - có cả connection lẫn env → không trùng lặp model
  - [ ] `tests/unit/devin-validate.test.js` (NEW): mock `fetch`
    - 200 → `{ valid: true }`; 401/403 → `{ valid: false }`; gọi đúng URL `/v1/sessions` với Bearer
  - [ ] Regression: `/v1/models` cho provider khác không đổi; validate provider khác không đổi

## Dev Notes

### Ràng buộc bắt buộc

- **KHÔNG log API key Devin** (`apk_*`, `cog_*`) ở bất kỳ đâu (NFR29). Không return trong API response (ngoài masked), không trong error message.
- **KHÔNG viết executor ở N.1.** Không tạo `open-sse/executors/devin.js`, không sửa `open-sse/executors/index.js` — đó là N.2. Nếu đụng vào sẽ vượt scope và gây review fail.
- **Sửa đồng bộ 3 registry** (T1 `PROVIDERS`, T2 `PROVIDER_MODELS`, T3 `AI_PROVIDERS`). Thiếu 1 trong 3 → drift: vd thiếu T3 thì `providerMatchesKinds` loại devin khỏi `/v1/models`; thiếu T2 thì `PROVIDER_MODELS["devin"]` rỗng → 0 model.
- **Chỉ THÊM `case "devin"`**, KHÔNG sửa case sẵn có trong validate/testUtils (tránh regression AC8).
- **`format: "devin"` là custom** — đảm bảo không có nơi nào assume format ∈ {openai, claude, gemini,...} mà crash khi gặp "devin" ở các đường mã N.1 chạm tới. (Translation/executor xử lý format ở N.2; N.1 chỉ liên quan model-listing + validate, đã verify không crash.)

### Devin API — shape cần biết (cho validate)

```
GET https://api.devin.ai/v1/sessions
Headers: Authorization: Bearer <apk_*|cog_*>
→ 200 + danh sách sessions = key hợp lệ
→ 401/403 = key sai/không đủ quyền
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
- Với env test: set/restore `process.env.DEVIN_API_KEY` trong `beforeEach`/`afterEach`.

### References

- Devin API overview: https://docs.devin.ai/api-reference/overview
- Devin v1 create/get/message session: https://docs.devin.ai/api-reference/v1/sessions/*
- [Source: _bmad-output/planning-artifacts/epics.md#Epic N — Devin Provider Integration] — FR110, FR118, FR119, FR120
- [Source: src/app/api/v1/models/route.js#buildModelsList] — line 211-420, cách expose model theo connection + serviceKinds
- [Source: src/shared/constants/providers.js] — line 70-208 (APIKEY_PROVIDERS, AI_PROVIDERS merge), 234-249 (alias helpers)
- [Source: open-sse/config/providerModels.js] — line 944-967 (OAUTH_ALIASES, PROVIDER_ID_TO_ALIAS)
- [Source: src/app/api/providers/validate/route.js] — line 246-622 (switch provider), 586-591 (default fallthrough)
- [Source: src/app/api/providers/[id]/test/testUtils.js] — line 380+ (switch connection.provider)
- [Source: docs/stories/2-35a-v98store-payg-api.md] — story provider-integration tương tự (mẫu format)

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (BMAD Create Story — exhaustive analysis + design 2026-06-25)

### Debug Log References

### Completion Notes List

### File List
