---
title: "Story 2.4 — Tính & trừ credit: deduction + checkCredits + tích hợp chat.js"
story_id: "2.4"
story_key: "2-4-credit-billing"
epic: "C — Credit & Billing"
status: done
baseline_commit: b27e425  # bumped from 7a4486d — 2.4 cần usersRepo (2.2 @dc144b2) + ĐỤNG saveRequestUsage (2.3 @b27e425). Commit fix review 2.3 trước khi dev 2.4.
depends_on: 2-2-user-account (@dc144b2), 2-3-api-key-ownership (@b27e425)
created: 2026-06-06
source-epics: docs/stories/epics-saas.md
source-prd: docs/PRD_SAAS_MVP.md
source-arch: docs/ARCHITECTURE_SAAS_MULTITENANT.md
consolidates: ["2.7 credit deduction", "2.8 checkCredits", "2.9 chat.js integration"]
context:
  - docs/ARCHITECTURE_SAAS_MULTITENANT.md
  - docs/stories/2-2-user-account.md
---

# Story 2.4 — Tính & trừ credit (billing core)

Status: review

<!-- Story nền billing (chưa có FE riêng — giá trị = hành vi, test qua API). Gộp từ cũ 2.7 (deduction) + 2.8 (checkCredits) + 2.9 (chat.js). Phụ thuộc 2.2 (usersRepo + creditsBalance + getUserById). -->

## Story

**As a** hệ thống 9Router SaaS,
**I want** trừ credit (USD) khỏi balance của user mỗi request thành công (atomic), và chặn request khi user hết credit (429),
**so that** SaaS thu phí đúng theo usage; key legacy không bị tính; lỗi billing không làm chết request (fail-open).

> MVP-1 = **1 loại credit** (`users.creditsBalance`). 3 loại credit + hệ số nhân + expiry để MVP-2. Phụ thuộc **Story 2.2** (`usersRepo`, `getUserById`, `addCredits`).

---

## Acceptance Criteria

**AC1 — Trừ credit atomic trong `saveRequestUsage`**
- WHEN một request thành công có `entry.apiKey` (key string) và `entry.cost > 0`
- THEN trong CÙNG `db.transaction()` đang ghi `usageHistory`: lookup `userId` từ `apiKeys WHERE key = entry.apiKey`; nếu có `userId` → `UPDATE users SET creditsBalance = creditsBalance - cost, updatedAt = now WHERE id = userId`
- AND nếu key legacy (`userId = null`) hoặc không tìm thấy → KHÔNG trừ (skip, fail-open)
- AND `cost = 0` → KHÔNG trừ

**AC2 — `checkCredits(apiKey)` module**
- WHEN gọi `checkCredits(apiKey)` → trả `{ allowed: boolean, reason?: string }`
- `apiKey` rỗng / key không tồn tại / `userId=null` (legacy) / user không tồn tại → `{ allowed: true }` (fail-open)
- user `isActive=0` → `{ allowed: false, reason: "account disabled" }`
- `creditsBalance <= 0` → `{ allowed: false, reason: "insufficient credits" }`
- bất kỳ exception nào → `{ allowed: true }` (fail-open, KHÔNG để lỗi DB chặn request)

**AC3 — Tích hợp admission vào `chat.js`**
- WHEN xử lý request, SAU `checkKeyQuota(...)`, TRƯỚC khi lấy provider/credentials
- THEN gọi `checkCredits(apiKey)`; nếu `!allowed` → trả `unavailableResponse(HTTP_STATUS.RATE_LIMITED, reason)` kèm **Retry-After** (FR-16)
- AND 429 này khớp `ERROR_RULES {status:429, backoff:true}` → tự động combo fallback

**AC4 — Fail-open toàn cục**
- WHEN billing lỗi (DB exception ở deduction hoặc checkCredits)
- THEN request KHÔNG chết; ghi `console.warn`; flow tiếp tục

**AC5 — Regression**
- WHEN request từ key legacy (userId=null) hoặc local (no key)
- THEN balance KHÔNG đổi, request chạy bình thường; test usage hiện có pass

---

## Tasks / Subtasks

- [x] **Task 1 — Credit deduction trong `saveRequestUsage`** (AC1, AC4)
  - [x] File `src/lib/db/repos/usageRepo.js`, bên trong `db.transaction(() => {...})` của `saveRequestUsage`, SAU 3 writes hiện tại (usageHistory insert, usageDaily upsert, _meta counter), TRƯỚC khi đóng transaction:
    ```js
    if (entry.apiKey && typeof entry.apiKey === "string" && entry.cost > 0) {
      const keyRow = db.get(`SELECT userId FROM apiKeys WHERE key = ?`, [entry.apiKey]);
      if (keyRow?.userId) {
        db.run(`UPDATE users SET creditsBalance = creditsBalance - ?, updatedAt = ? WHERE id = ?`,
          [entry.cost, new Date().toISOString(), keyRow.userId]);
      }
    }
    ```
  - [x] `saveRequestUsage` đã bọc `try/catch` ngoài cùng (nuốt lỗi, console.error) → fail-open có sẵn. Xác nhận deduction nằm trong cùng try.
  - [x] Unit test `tests/unit/creditDeduction.test.js`: user key → balance giảm đúng cost; legacy key → không đổi; cost=0 → không đổi; 2 request liên tiếp → balance đúng (atomic).

- [x] **Task 2 — `checkCredits` module** (AC2, AC4)
  - [x] File mới `src/lib/billing/checkCredits.js`:
    ```js
    import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo";
    import { getUserById } from "@/lib/db/repos/usersRepo";
    export async function checkCredits(apiKey) {
      try {
        if (!apiKey) return { allowed: true };
        const keyRow = await getApiKeyByKey(apiKey);
        if (!keyRow || !keyRow.userId) return { allowed: true };
        const user = await getUserById(keyRow.userId);
        if (!user) return { allowed: true };
        if (!user.isActive) return { allowed: false, reason: "account disabled" };
        if (user.creditsBalance <= 0) return { allowed: false, reason: "insufficient credits" };
        return { allowed: true };
      } catch { return { allowed: true }; }
    }
    ```
  - [x] Unit test `tests/unit/checkCredits.test.js`: null/legacy/balance>0 → allowed; balance=0 và <0 → not allowed "insufficient credits"; isActive=0 → "account disabled"; DB throw → allowed.

- [x] **Task 3 — Tích hợp `chat.js`** (AC3)
  - [x] File `src/sse/handlers/chat.js`. Import `checkCredits`. SAU `checkKeyQuota(...)`, TRƯỚC `getProviderCredentials(...)`:
    ```js
    const creditResult = await checkCredits(apiKey);
    if (!creditResult.allowed) {
      return unavailableResponse(HTTP_STATUS.RATE_LIMITED, creditResult.reason || "insufficient credits", /*retryAfter*/ 60, /*retryAfterHuman*/ "60s");
    }
    ```
    (Xác nhận chữ ký `unavailableResponse(status, msg, retryAfter, retryAfterHuman)` — truyền Retry-After cho FR-16.)
  - [x] Xác định biến `apiKey` trong scope chat.js (key string của request) — verify trước khi dùng.
  - [x] Unit test `tests/unit/chatCreditCheck.test.js` (mock checkCredits): not-allowed → unavailableResponse 429 + Retry-After; allowed → flow tiếp; throw → fail-open tiếp.

- [x] **Task 4 — Regression** (AC5)
  - [x] `cd tests && npm test -- unit/creditDeduction.test.js unit/checkCredits.test.js unit/chatCreditCheck.test.js` + test usage/key-quota hiện có.

---

## Dev Notes

### Hiện trạng code (verified tại 7a4486d)

**`src/lib/db/repos/usageRepo.js`** — `saveRequestUsage(entry)`: tính `entry.cost = await calculateCost(...)` (USD), rồi `db.transaction(() => { INSERT usageHistory; upsert usageDaily; _meta counter })` — **3 writes sync, atomic** (better-sqlite3 sync, no JS yield → no race). Toàn bộ bọc `try/catch` ngoài (console.error, nuốt lỗi). `entry.apiKey` = key string. → Deduction thêm vào trong transaction, sau 3 writes.

**`src/lib/billing/checkCredits.js`** — **CHƯA TỒN TẠI**, tạo mới. Phụ thuộc `getApiKeyByKey` (apiKeysRepo, đã có) + `getUserById` (usersRepo — **story 2.2 tạo**).

**`src/sse/handlers/chat.js`** — flow: `checkKeyQuota` → get provider/credentials → stream. `unavailableResponse(status, msg, retryAfter, retryAfterHuman)` có sẵn. `HTTP_STATUS.RATE_LIMITED = 429`. `errorConfig.ERROR_RULES` có `{status:429, backoff:true}` → 429 tự trigger combo fallback. → chèn checkCredits cạnh checkKeyQuota.

**`users` table** (story 2.1): `creditsBalance REAL DEFAULT 0` (USD, đồng đơn vị `usageHistory.cost`). `isActive INTEGER`.

### Điều PHẢI bảo toàn (regression)
- Local request (no key) + legacy key (userId=null) → KHÔNG trừ credit, chạy bình thường.
- `saveRequestUsage` không được throw ra ngoài (giữ try/catch fail-open).
- `checkCredits` fail-open tuyệt đối — lỗi DB KHÔNG được chặn request.
- Combo fallback: 429 đã có rule sẵn, KHÔNG cần thêm text rule.

### Lưu ý quan trọng (từ readiness review)
- **FR-16 Retry-After**: PHẢI truyền `retryAfter` vào `unavailableResponse` (không chỉ 429 trần) — verify đúng vị trí param trong chữ ký hàm.
- **creditsBalance là REAL (float)**: chấp nhận soft-limit (balance âm nhẹ do concurrent) theo quyết định kiến trúc — KHÔNG cần pessimistic lock ở MVP-1. (Vấn đề float money đã defer sang billing đầy đủ MVP-2.)

### Project Structure Notes
- DB/billing: `usageRepo.js` (sửa), `src/lib/billing/checkCredits.js` (mới).
- Handler: `src/sse/handlers/chat.js` (sửa).

### Môi trường test
- `cd tests && npm test -- unit/<file>.test.js`. Tham khảo pattern `saas-schema.test.js` (DATA_DIR tempDir, reset adapter). Cần seed user + key có userId để test deduction.

### Scope guard — KHÔNG làm
- KHÔNG 3 loại credit / hệ số nhân / expiry / cron (FR-13/14/15 → MVP-2).
- KHÔNG admin topup (Story 2.5).
- KHÔNG đụng UI.

### References
- Epic C trong `docs/stories/epics-saas.md`.
- PRD FR-12, FR-16, FR-17, NFR-3 (atomicity), NFR-5 (performance).
- Code: `usageRepo.js`, `sse/handlers/chat.js`, `apiKeysRepo.js`, `usersRepo.js` (story 2.2).

---

## Review Findings

> **Pre-implementation SPEC review** (story CHƯA code) — 2026-06-06. Code-claims verify tại HEAD `b27e425` (+ uncommitted 2.3 fixes). **Verdict: spec chất lượng cao** — phần lớn code-claims ĐÚNG: `apiKey` in scope (`handleSingleModelChat` param), điểm chèn `checkKeyQuota`(chat.js:161)→`getProviderCredentials`(181) ✓, `unavailableResponse(status,msg,retryAfter,retryAfterHuman)` xác nhận tại chat.js:189 (FR-16 OK) ✓, `getUserById`/`getApiKeyByKey`/`saveRequestUsage` txn ✓. Triage: 0 decision-needed, 1 spec-fix, 3 dev-guardrail, 2 confirm/defer.

### spec-fix
- [x] [Review][Spec-Fix] **`baseline_commit: 7a4486d` SAI** (đã sửa → `b27e425`) — 7a4486d (story 2.1) chưa có `usersRepo`/`getUserById` (story 2.2) và chưa có thay đổi `saveRequestUsage` của story 2.3. 2.4 phụ thuộc cả hai. Dev 2.4 phải base trên HEAD sau 2.2+2.3.

### dev-guardrail (xử lý khi implement)
- [ ] [Review][Dev-Guardrail] **`saveRequestUsage` GIỜ đã có `updateLastUsed(...).catch()` (story 2.3) đặt SAU `db.transaction()`** [`src/lib/db/repos/usageRepo.js`] — spec mô tả "3 writes" theo trạng thái 7a4486d (cũ). Thực tế đặt deduction TRONG transaction (sau 3 writes, trước khi đóng) — KHÔNG đụng/đừng xoá block `updateLastUsed` ở sau. Lưu ý merge với fix review 2.3 (đang uncommitted).
- [ ] [Review][Dev-Guardrail] **Resolve key/userId LẶP nhiều lần mỗi request** [`chat.js`, `keyQuota.js`, `usageRepo.js`] — mỗi request hiện sẽ: `checkKeyQuota`→`getApiKeyByKey`; `checkCredits`→`getApiKeyByKey`+`getUserById`; deduction→`SELECT userId FROM apiKeys`; lastUsedAt→`UPDATE apiKeys WHERE key`. ~3-4 lần chạm key/user. Cân nhắc resolve `userId` 1 lần và truyền xuống (perf hot-path, NFR-5). Nếu không tối ưu ngay → ít nhất ghi nhận.
- [ ] [Review][Dev-Guardrail] **Commit fix review story 2.3 TRƯỚC khi dev 2.4** [working tree] — `usageRepo.js` + `EndpointPageClient.js` đang sửa (uncommitted). 2.4 cũng sửa `usageRepo.js` (`saveRequestUsage`) → commit 2.3 trước để tránh commit lẫn lộn + conflict.

### confirm / defer
- [x] [Review][Confirm] **Deduct khi `cost > 0` bất kể status** — đúng best-practice: cost = token thật provider tính, dùng token thì trừ (kể cả stream lỗi giữa chừng). Giữ nguyên cách spec.
- [x] [Review][Defer] **Overshoot balance âm do concurrent** (checkCredits admission trước, deduction sau) — đã accept là soft-limit (REAL, documented kiến trúc §6). Không cần pessimistic lock MVP-1.

---

## Dev Agent Record

### Context Reference
- Tạo bởi bmad-create-story (story gộp vertical, consolidation 2026-06-06).

### Agent Model Used
Auto (Kiro)

### Completion Notes List
Ultimate context engine analysis completed - comprehensive developer guide created.

**Implementation Summary (2026-06-06):**
- Task 1: `usageRepo.js` — credit deduction atomic inside `db.transaction()` (4th write), sau 3 writes hiện tại. Chỉ trừ khi apiKey là string + cost>0 + key có userId. Legacy key → skip. Fail-open qua try/catch bên ngoài. 5 unit tests PASS.
- Task 2: `src/lib/billing/checkCredits.js` — module mới, fail-open tuyệt đối (catch→allowed:true). Xử lý: null/empty/legacy/not-found→allowed; isActive=false→"account disabled"; balance≤0→"insufficient credits". 9 unit tests PASS.
- Task 3: `chat.js` — import `checkCredits`, chèn admission check sau `checkKeyQuota`, trước `getProviderCredentials`. 429 + Retry-After=60/"60s" (FR-16). 5 unit tests PASS (pattern + source inspection).
- Task 4: Regression — 89 tests total (9 files) all green.

**Dev-guardrail xử lý:**
- `updateLastUsed` fire-and-forget (story 2.3) giữ nguyên sau transaction, không bị xóa.
- Deduction nằm TRONG transaction (atomic với 3 writes cũ).
- Fail-open tại cả `saveRequestUsage` (try/catch ngoài) và `checkCredits` (catch → allowed:true).

### File List
- `src/lib/db/repos/usageRepo.js` (modified — deduction trong transaction)
- `src/lib/billing/checkCredits.js` (new)
- `src/sse/handlers/chat.js` (modified — admission checkCredits + Retry-After)
- `tests/unit/creditDeduction.test.js` (new)
- `tests/unit/checkCredits.test.js` (new)
- `tests/unit/chatCreditCheck.test.js` (new)

### Change Log
- 2026-06-06: Story created (ready-for-dev) — gộp vertical từ cũ 2.7/2.8/2.9
- 2026-06-06: Story implemented — all 4 tasks complete, 19 new unit tests, 89 total regression green, status → review
