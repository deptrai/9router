---
title: "Story 2.3 — Sở hữu API key: ownership + routes role-aware + key table UI"
story_id: "2.3"
story_key: "2-3-api-key-ownership"
epic: "B — API Key Ownership"
status: ready-for-dev
baseline_commit: dc144b2  # D1: bumped from 7a4486d (story 2.1) — 2.3 depends on story 2.2 @ dc144b2 (role/userId in JWT). Dev 2.3 only AFTER 2.2 approved.
depends_on: 2-2-user-account (status: review @ dc144b2)
created: 2026-06-06
source-epics: docs/stories/epics-saas.md
source-prd: docs/PRD_SAAS_MVP.md
source-arch: docs/ARCHITECTURE_SAAS_MULTITENANT.md
consolidates: ["2.5 apiKeysRepo ownership", "2.6 keys routes role-aware", "2.17 key table UI"]
context:
  - docs/ARCHITECTURE_SAAS_MULTITENANT.md
  - docs/UX_SAAS_MVP1.md
  - docs/stories/2-2-user-account.md
---

# Story 2.3 — Sở hữu API key (ownership + routes + UI)

Status: ready-for-dev

<!-- Vertical slice gộp từ cũ 2.5 (apiKeysRepo ownership) + 2.6 (routes role-aware) + 2.17 (key table UI). Nhịp dev: DB → BE → FE. Phụ thuộc story 2.2 (role trong JWT + userId). -->

## Story

**As a** user của 9Router SaaS,
**I want** tạo/xem/sửa/xoá API key của riêng mình (tối đa 10 key), thấy Description / Last Used / Credit Usage của từng key,
**so that** tôi quản lý được key của mình mà không thấy/đụng key của user khác; admin vẫn thấy toàn bộ; key legacy (`userId=null`) chạy không giới hạn.

> Phụ thuộc **Story 2.2** (JWT có `role/userId`). Story 2.1 đã có cột `userId/description/lastUsedAt` + `createApiKey(name, machineId, userId, description)`.

---

## Acceptance Criteria

**AC1 — `apiKeysRepo`: 10-key limit + getByUser + updateLastUsed**
- WHEN gọi `createApiKey(name, machineId, userId, description)` với `userId != null` và user đã có ≥ 10 key
- THEN throw `Error("Key limit reached: max 10 keys per user")` (không INSERT)
- WHEN `userId == null` (legacy/admin) → KHÔNG đếm giới hạn
- AND có `getApiKeysByUser(userId)` trả keys của user (ORDER BY createdAt ASC)
- AND có `updateLastUsed(keyString)` cập nhật `lastUsedAt = now` theo key string
- AND tất cả export qua `src/lib/db/index.js`

**AC2 — `lastUsedAt` cập nhật khi key được dùng**
- WHEN một request gọi LLM API qua key (validate thành công)
- THEN `lastUsedAt` của key đó được cập nhật (fire-and-forget, KHÔNG block request chain, KHÔNG throw nếu lỗi)

**AC3 — `GET /api/keys` role-aware**
- WHEN role=user → chỉ trả keys của user (`getApiKeysByUser(session.userId)`)
- WHEN role=admin (hoặc legacy token) → trả tất cả (`getApiKeys()`)

**AC4 — `POST /api/keys` gắn ownership + description**
- WHEN role=user tạo key → key có `userId = session.userId`, `description` từ body
- WHEN role=admin tạo key → `userId = null` (giữ hành vi hiện tại)
- WHEN user đã đủ 10 key → 400 với message "Đã đạt giới hạn 10 keys"

**AC5 — `PUT/DELETE /api/keys/[id]` ownership guard**
- WHEN role=user thao tác trên key KHÔNG thuộc mình (`key.userId !== session.userId`) → 403
- WHEN key không tồn tại → 404
- WHEN role=admin → thao tác được trên mọi key
- AND PUT hỗ trợ cập nhật `description`

**AC6 — Key table UI (FR-10)**
- WHEN xem trang Endpoint
- THEN bảng key có thêm cột: Description, Last Used (relative/"—"), Credit Usage ($X.XX từ usage stats `byApiKey`)
- AND modal Create Key có input Description (optional); modal Edit Key có field Description

**AC7 — Regression**
- WHEN admin dùng flow hiện tại (tạo key không userId)
- THEN hoạt động như cũ; key legacy unlimited; test cũ pass

---

## Tasks / Subtasks

### Lớp DB
- [ ] **Task 1 — apiKeysRepo ownership** (AC1, AC2)
  - [ ] `createApiKey(name, machineId, userId=null, description=null)` — thêm: nếu `userId` → `const n = db.get("SELECT COUNT(*) c FROM apiKeys WHERE userId = ?", [userId]).c; if (n >= 10) throw new Error("Key limit reached: max 10 keys per user")` TRƯỚC khi INSERT.
  - [ ] `getApiKeysByUser(userId)` (mới): `SELECT * FROM apiKeys WHERE userId = ? ORDER BY createdAt ASC` → `.map(rowToKey)`.
  - [ ] `updateLastUsed(keyString)` (mới): `db.run("UPDATE apiKeys SET lastUsedAt = ? WHERE key = ?", [new Date().toISOString(), keyString])`.
  - [ ] Export `getApiKeysByUser`, `updateLastUsed` qua `src/lib/db/index.js` (block "API keys").
  - [ ] `validateApiKey(key)`: sau khi xác nhận hợp lệ, gọi `updateLastUsed(key)` **không await** (fire-and-forget, bọc try/catch nuốt lỗi). Cân nhắc throttle (chỉ update nếu lastUsedAt cũ > 60s) để tránh write mỗi request — optional, ghi chú trong code.
  - [ ] Unit test `tests/unit/apiKeysRepo.test.js`: 11th key throw; getApiKeysByUser filter đúng; updateLastUsed cập nhật; createApiKey không userId → không đếm limit.

### Lớp BE — routes
- [ ] **Task 2 — `/api/keys` GET + POST role-aware** (AC3, AC4)
  - [ ] File `src/app/api/keys/route.js`. Thêm helper lấy session: `getDashboardAuthSession(request.cookies.get("auth_token")?.value)` (route handler dùng `cookies()` từ `next/headers` hoặc `request.cookies`). Note: route hiện là `export async function GET()` không nhận request → đổi thành `GET(request)`.
  - [ ] GET: `role==="user"` → `getApiKeysByUser(session.userId)`; else `getApiKeys()`. `role = session?.role ?? "admin"`.
  - [ ] POST: `userId = role==="user" ? session.userId : null`; `description = body.description ?? null`; `createApiKey(name, machineId, userId, description)`. Bắt lỗi limit → 400 "Đã đạt giới hạn 10 keys". Trả thêm `description` trong response.
  - [ ] Unit test `tests/unit/keysRoutes.test.js`: user GET chỉ key mình; admin GET all; POST user gắn userId; key 11 → 400.

- [ ] **Task 3 — `/api/keys/[id]` PUT + DELETE ownership guard** (AC5)
  - [ ] File `src/app/api/keys/[id]/route.js` (đã có GET/PUT/DELETE). Thêm session + ownership check ở PUT/DELETE: `key = getApiKeyById(id)`; `!key → 404`; `role==="user" && key.userId !== session.userId → 403`.
  - [ ] PUT: cho phép cập nhật `description` (thêm vào `updateData` nếu body có).
  - [ ] Test trong `keysRoutes.test.js`: user DELETE key người khác → 403; admin DELETE bất kỳ → OK; PUT description.

### Lớp FE — UI
- [ ] **Task 4 — Key table + modals** (AC6)
  - [ ] File `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`.
  - [ ] Bảng key thêm cột: **Description** (truncate + Tooltip full), **Last Used** (relative time hoặc "—"), **Credit Usage** ($ từ `/api/usage/stats` `byApiKey`, group theo key string client-side — Badge xám).
  - [ ] Modal Create Key: thêm `Description` (textarea 2 rows, optional) → gửi vào POST body.
  - [ ] Modal Edit Key: thêm field Description → PUT `/api/keys/[id]`.
  - [ ] Toast lỗi khi POST trả 400 limit: "Đã đạt giới hạn 10 keys".
  - [ ] Manual test (UI).

### Regression
- [ ] **Task 5** (AC7): chạy `cd tests && npm test -- unit/apiKeysRepo.test.js unit/keysRoutes.test.js` + test key/dashboard hiện có. Xác nhận admin flow + legacy key unlimited không vỡ.

---

## Dev Notes

### Hiện trạng code (re-verified tại `dc144b2` — ⚠️ vài claim bên dưới đã được ĐÍNH CHÍNH ở `## Review Findings`: `updateApiKey` KHÔNG lọc undefined; PUT chỉ đọc `isActive`; routes import từ `@/lib/localDb` chứ không phải `@/lib/db`)

**`src/lib/db/repos/apiKeysRepo.js`** — đã có (story 2.1): `rowToKey` trả `userId/description/lastUsedAt`; `createApiKey(name, machineId, userId=null, description=null)` INSERT 8 cột (chưa có limit check); `updateApiKey` dùng merge `{ ...rowToKey(row), ...data }` — **KHÔNG lọc undefined** (review 2.1 ghi "fixed" nhưng code thật CHƯA áp dụng → khi PUT thêm `description`/`name`, tránh truyền `undefined`, hoặc thêm bước lọc undefined trước spread); `getApiKeyByKey`, `validateApiKey` (chỉ SELECT isActive, trả boolean). **Chưa có** `getApiKeysByUser`, `updateLastUsed`.

**`src/app/api/keys/route.js`** — GET hiện `export async function GET()` (KHÔNG nhận request) → `getApiKeys()` trả all. POST `createApiKey(name, machineId)` (machineId = `getConsistentMachineId()`), KHÔNG đọc userId/description. → cần đổi signature GET sang `GET(request)` + thêm session.

**`src/app/api/keys/[id]/route.js`** — đã có GET/PUT/DELETE. PUT hiện CHỈ đọc/ghi `isActive` (`if (isActive !== undefined) updateData.isActive = isActive`) — **KHÔNG có `name`, KHÔNG có description**. 2.3 thêm `description` (và `name` nếu cho sửa). DELETE `deleteApiKey(id)`. **Chưa có ownership check.**

**`src/lib/db/repos/usageRepo.js`** — `getUsageStats(period)` build `byApiKey` keyed `"${apiKey}|${model}|${provider}"`, mỗi entry có field `apiKey` (key string) + `cost`. Credit Usage per key = sum `cost` các entry cùng `apiKey`. UI join client-side theo key string. (Filter theo user là việc của story 2.5; key table chỉ cần tổng theo key string nên KHÔNG phụ thuộc 2.5.)

**`src/lib/db/index.js`** — barrel; block "API keys" export `getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey`. Thêm `getApiKeysByUser, updateLastUsed`.

**Session helper**: `getDashboardAuthSession(token)` (từ `@/lib/auth/dashboardSession`) → payload `{ role, userId, email, ... }` hoặc null. `role = session?.role ?? "admin"` (legacy/admin).

### Điều PHẢI bảo toàn (regression)
- Admin tạo key (không userId) → unlimited, hành vi cũ.
- `validateApiKey` vẫn trả boolean như cũ; `updateLastUsed` chỉ là side-effect non-blocking — KHÔNG đổi giá trị trả về, KHÔNG throw.
- `generateApiKeyWithMachine` + machineId required: KHÔNG đổi.
- `getApiKeys()` (all) vẫn dùng cho admin + cho `getUsageStats`.

### Project Structure Notes
- DB: `apiKeysRepo.js` + export `index.js`.
- BE: `app/api/keys/route.js`, `app/api/keys/[id]/route.js`.
- FE: `app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`.
- UX guide: `docs/UX_SAAS_MVP1.md` §4 (key table + modals).

### Môi trường test
- `cd /Users/luisphan/Documents/9router/tests && npm test -- unit/<file>.test.js` (vitest@4, alias `@/`→`src/`, DATA_DIR tempDir + reset `global._dbAdapter`).

### Scope guard — KHÔNG làm
- KHÔNG per-key credit limit (FR-9 → MVP-2).
- KHÔNG trừ credit (Story 2.4).
- KHÔNG usage filter theo user (Story 2.5) — key table dùng tổng theo key string là đủ.

### References
- Epic B trong `docs/stories/epics-saas.md`.
- PRD FR-7, FR-8, FR-10, FR-11.
- UX: `docs/UX_SAAS_MVP1.md` §4.
- Code: `apiKeysRepo.js`, `app/api/keys/route.js`, `app/api/keys/[id]/route.js`, `usageRepo.js`.

---

## Review Findings

> **Pre-implementation SPEC review** (story CHƯA code) — 2026-06-06. Code-claims verify tại HEAD `dc144b2` (develop). Lớp review: Code-Claim Verifier + Acceptance Auditor + Edge-Case Hunter. Tổng: 5 decision-needed (đã resolve), 2 spec-fix, 4 dev-guardrail, 5 defer.

### decision-needed → ĐÃ RESOLVE (best-practice, Luisphan ủy quyền 2026-06-06)
- [x] [Review][Decision] **baseline sai thứ tự dependency** → **(a)** bump `baseline_commit` → `dc144b2`; dev 2.3 CHỈ sau khi story 2.2 approved. Không build trên dependency chưa review/merge.
- [x] [Review][Decision] **AC2 `lastUsedAt` hook + throttle** → **KHÔNG** đặt `updateLastUsed` trong `validateApiKey` (hàm này chạy cả ở `dashboardGuard` middleware → 2 ghi/request). Thay vào: cập nhật `lastUsedAt` BÊN TRONG transaction sẵn có của `saveRequestUsage` (`usageRepo.js`) — atomic, 1 ghi mỗi request đã hoàn tất, đúng chỗ story 2.4 sẽ trừ credit. Vẫn export `updateLastUsed(keyString)` cho unit test; throttle không còn bắt buộc (đã 1 ghi/request).
- [x] [Review][Decision] **AC6 modal Edit Key** → **(a)** DỰNG MỚI modal Edit Key (Name read-only + Status toggle + Description textarea) vì hiện chưa có. Task 4 phải tính scope này; backend PUT phải nhận `description`.
- [x] [Review][Decision] **10-key limit active/tổng** → **(b)** đếm key **active**: `WHERE userId = ? AND isActive = 1`. Công bằng với user; delete là hard-delete nên xoá key giải phóng slot. (Caveat disable-rồi-tạo-mới tích lũy row → xem defer.)
- [x] [Review][Decision] **`/api/usage/stats` lộ usage cross-user** → **(a)** chấp nhận tới story 2.5 (2.5 thêm filter `userId` + route-guard role). RÀNG BUỘC: KHÔNG mở multi-tenant production trước khi 2.5 xong. Key table 2.3 chỉ join cost theo key string của chính user.

### spec-fix (spec ghi SAI sự thật — ✅ ĐÃ SỬA Dev Notes 2026-06-06)
- [x] [Review][Spec-Fix] **Claim SAI: "updateApiKey dùng merge filter-undefined"** [`src/lib/db/repos/apiKeysRepo.js:58`] — code thật là `const merged = { ...rowToKey(row), ...data }`, KHÔNG lọc undefined (dù review 2.1 ghi "Fixed: filter undefined"). Sửa Dev Notes cho đúng; nên thực sự thêm lọc undefined để PUT description/name merge an toàn (tránh wipe field thành null).
- [x] [Review][Spec-Fix] **Claim SAI: PUT `/api/keys/[id]` build updateData từ `{name, isActive}`** [`src/app/api/keys/[id]/route.js:26`] — code chỉ đọc/ghi `isActive` (không có `name`). 2.3 thêm `description`; `name` vẫn KHÔNG persist. Nếu Edit modal cho sửa Name → không lưu được. Align: thêm `name` vào PUT, hoặc note Name read-only.

### dev-guardrail (spec không sai nhưng thiếu bẫy — dev phải xử lý khi implement)
- [ ] [Review][Dev-Guardrail] **Barrel mismatch — phải export 2 hàm mới qua `@/lib/localDb` nữa** [`src/lib/localDb.js:13`] — routes import `getApiKeys/createApiKey` từ `@/lib/localDb` (shim re-export THỦ CÔNG, KHÔNG `export *`). Spec chỉ bảo thêm vào `src/lib/db/index.js`. Dev PHẢI thêm `getApiKeysByUser, updateLastUsed` vào CẢ `localDb.js` (hoặc đổi import của routes sang `@/lib/db`). Nếu không → `undefined is not a function` lúc chạy.
- [ ] [Review][Dev-Guardrail] **POST limit-error mapping dựa string-match mong manh** [`src/app/api/keys/route.js`] — AC1 throw `Error("Key limit reached: max 10 keys per user")` (EN); AC4 map → 400 + msg VN. Phân biệt limit-error bằng `error.message` rất giòn. Dùng typed error (vd `err.code = "KEY_LIMIT"`) hoặc pre-check COUNT trong route; KHÔNG trả `error.message` thô.
- [ ] [Review][Dev-Guardrail] **Trang Endpoint hiện CHƯA fetch `/api/usage/stats`** [`EndpointPageClient.js`] — cột Credit Usage cần thêm fetch usage-stats + join client-side theo key string; spec nêu nguồn data nhưng không nói rõ phải thêm fetch mới (hiện chỉ fetch `/api/keys`).
- [ ] [Review][Dev-Guardrail] **Session wiring: `getDashboardAuthSession` là async + chốt pattern cookie** [`src/app/api/keys/route.js`, `[id]/route.js`] — phải `await`; thống nhất cách lấy cookie với `/api/users/me` của 2.2 (`cookies()` từ `next/headers` vs `request.cookies`). Pseudocode spec bỏ `await`.

### defer (ngoài scope / pre-existing)
- [x] [Review][Defer] TOCTOU 10-limit — COUNT+INSERT không atomic, 2 request đồng thời có thể vượt 10 [`apiKeysRepo.js`] — rủi ro thấp (tạo key hiếm), chấp nhận như soft-limit.
- [x] [Review][Defer] Orphan keys khi deactivate user — 2.2 `deactivateUser` set `isActive=0` nhưng giữ `userId`; không FK cascade (đã note ở 2.1). Key vẫn bị đếm/sở hữu.
- [x] [Review][Defer] role=user nhưng thiếu `userId` → `getApiKeysByUser(null)` trả `[]` (user không thấy key nào) — edge phòng thủ.
- [x] [Review][Defer] Tái dùng `src/lib/auth/requireRole.js` (untracked: `requireAdmin/getSessionRole`) thay vì inline `role ?? "admin"` — optional, có thể là artifact của story 2.5.
- [x] [Review][Defer] Token legacy/null bị coi là admin → thấy mọi key [`route.js`] — by design (backward-compat), kế thừa caveat "role chưa enforce ở guard" của 2.2.

---

## Dev Agent Record

### Context Reference
- Tạo bởi bmad-create-story (story gộp vertical, consolidation 2026-06-06).

### Agent Model Used
Auto (Kiro)

### Completion Notes List
Ultimate context engine analysis completed - comprehensive developer guide created.

### File List
- `src/lib/db/repos/apiKeysRepo.js` (modified — 10-limit, getApiKeysByUser, updateLastUsed)
- `src/lib/db/index.js` (modified — export 2 hàm mới)
- `src/app/api/keys/route.js` (modified — GET(request) + POST role-aware)
- `src/app/api/keys/[id]/route.js` (modified — ownership guard + description)
- `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` (modified — cột Description/Last Used/Credit Usage + modals)
- `tests/unit/apiKeysRepo.test.js` (new)
- `tests/unit/keysRoutes.test.js` (new)

### Change Log
- 2026-06-06: Story created (ready-for-dev) — gộp vertical từ cũ 2.5/2.6/2.17
- 2026-06-06: Pre-implementation SPEC review (code-review skill). 5 decision-needed RESOLVED (best-practice), 6 patch = action item cho dev, 5 defer → `_bmad-output/implementation-artifacts/deferred-work.md`. Baseline bump 7a4486d→dc144b2. Status giữ `ready-for-dev` (story chưa code — KHÔNG set done/in-progress).
- 2026-06-06: Áp 2 `[Spec-Fix]` — sửa Dev Notes cho đúng code thật (`updateApiKey` KHÔNG lọc undefined; PUT chỉ đọc `isActive`). 4 `[Dev-Guardrail]` vẫn để dev xử lý khi implement.
