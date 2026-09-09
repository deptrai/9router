---
baseline_commit: 5383eb979c2775bc94ae2a063d11706f545de854
epic: E
---

# Story 2.15 (E.4): User Plan & Quota UI — quota/RPM/credit + ledger history + overflow toggle

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **user của 9Router có gói subscription (free/pro/max) hoặc dùng credit pay-as-you-go**,
I want **một trang dashboard xem được giới hạn gói của mình (quota token 5h/weekly đã dùng/còn lại, RPM), số dư credit, lịch sử giao dịch credit (ledger), và bật/tắt `allowCreditOverflow`**,
so that **tôi tự theo dõi được hạn mức + chi tiêu, hiểu vì sao bị chặn khi hết quota, và chủ động quyết định có cho phép tràn sang credit khi gói cạn hay không — không cần hỏi admin**.

## Bối cảnh & Quyết định kiến trúc

Đây là **E.4** — story UI user-facing, hiển thị mọi thứ E.1→E.3 đã dựng ở backend. Phụ thuộc (tất cả đã done):
- **E.1 (2-11)**: `resolveUserLimits(userId)` → `{ source, rpm, quota5h, quotaWeekly, planName }`; `sumUsageTokensByUser`.
- **E.2 (2-12)**: RPM `checkRpmLimit`, state `rpmState` (window 1m).
- **E.3 (2-14)**: `checkPlanQuota`, `users.allowCreditOverflow` (DEFAULT 0), `/api/users/me` PATCH đã nhận `allowCreditOverflow`; state `planQuotaState`.
- **E.3b (2-13)**: `creditLedgerRepo` — `getLedgerByUser(userId, {limit, offset, type, bucket})`, `rebuildBalanceFromLedger`.

### Phạm vi E.4 (epics-saas.md#Epic E)
> "UI cho user xem quota/RPM/credit + lịch sử ledger của chính mình (hiện chỉ admin thấy quota — tái dùng `dashboard/usage/components/ProviderLimits/`) + toggle `allowCreditOverflow`."

→ Story này là **read + 1 toggle write**. KHÔNG enforce gì mới (enforcement đã ở E.2/E.3). KHÔNG admin CRUD plan (đó là E.5). KHÔNG mua/đổi gói (E.7).

### CRITICAL — thiếu API user-facing (phải tạo)
Backend repo fns đã có, nhưng **chưa có route user gọi được**:
1. **Quota status API** (MỚI): user cần biết đã dùng/còn lại bao nhiêu mỗi window. `checkPlanQuota`/`resolveUserLimits` hiện chỉ gọi nội bộ ở admission. Cần `GET /api/users/me/quota` trả snapshot **không side-effect** (KHÔNG tăng/persist counter): plan limits + consumed per window + RPM hiện tại + source.
2. **Ledger history API** (MỚI): `getLedgerByUser` có ở repo nhưng chưa có route. Cần `GET /api/users/me/ledger?limit&offset&type` (chỉ ledger của chính session user — KHÔNG cho xem user khác).
3. **Toggle** (ĐÃ CÓ): `/api/users/me` PATCH `allowCreditOverflow` (2.14). Chỉ cần GET trả thêm field (kiểm tra 2.14 đã expose chưa) + UI gọi.

### CRITICAL — quota status phải READ-ONLY (no side-effect)
`checkPlanQuota` (admission) **persist window state khi reset** và là fail-CLOSED khi exhausted. API status cho UI **KHÔNG được** persist/tăng counter hay chặn — chỉ đọc. → Cần hàm mới `getPlanQuotaStatus(userId)` (hoặc tham số `dryRun`) tính consumed per window **mà không** ghi state, KHÔNG trả 429. Tránh: gọi thẳng `checkPlanQuota` từ API status (nó có side-effect persist + semantics chặn).

### Hạ tầng hiện có (đã đọc code)
- `src/app/(dashboard)/dashboard/credits/page.js` (445 dòng): **mẫu chuẩn** — `Card`, fetch `/api/auth/status` (balance), `/api/usage/stats`, payment/gift history, skeleton loading, Tailwind tokens (`text-text-main`, `bg-surface-2`, `text-primary`...). Trang mới TÁI DÙNG pattern này.
- `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/` (`QuotaProgressBar.js`, `QuotaTable.js`, `ProviderLimitCard.js`, `utils.js`): component progress-bar/quota admin đang dùng. **Tái dùng `QuotaProgressBar`** cho hiển thị consumed/limit nếu khớp; nếu prop khác thì viết component nhỏ tương tự (KHÔNG sửa ProviderLimits admin).
- `src/app/(dashboard)/dashboard/quota/page.js`: hiện chỉ render `<ProviderLimits/>` (admin per-provider quota). KHÔNG đụng — đó là quota tracker admin khác.
- `src/shared/components/Sidebar.js:34` `userNavItems`: `[endpoint, usage, credits]`. **Thêm** entry mới (vd `{ href: "/dashboard/plan", label: "Plan & Quota", icon: "verified" }`).
- `src/app/api/auth/status/route.js`: trả `creditsBalance`, `isEmailVerified`, `role`, `userId`. (Cân nhắc thêm `planId`/`allowCreditOverflow` nếu tiện, nhưng /api/users/me là nguồn chuẩn cho profile.)
- `src/app/api/users/me/route.js`: GET/PATCH session user. 2.14 đã thêm `allowCreditOverflow` PATCH. **Kiểm tra GET đã trả `allowCreditOverflow` + `planId`/`planExpiresAt` chưa**; nếu chưa, thêm.
- `src/lib/db/repos/creditLedgerRepo.js#getLedgerByUser`: `(userId, {limit=50, offset=0, type, bucket})` → ledger rows.
- `src/lib/quota/resolvePlan.js#resolveUserLimits`, `src/lib/db/repos/quotaRepo.js#sumUsageTokensByUser` + `getPlanQuotaState`/`getRpmState`: nguồn dữ liệu cho status API.
- `src/lib/quota/window.js#resolveWindow/duration/formatResetCountdown`: tính window hiện tại + reset countdown (READ-only — gọi `resolveWindow` để biết startedAt hiệu dụng nhưng KHÔNG persist).
- Auth user route: `getDashboardAuthSession` + check `session.role === "user"` (pattern ở `users/me/route.js`).

## Acceptance Criteria

1. **WHEN** user mở trang mới `/dashboard/plan` (đề xuất; hoặc mở rộng `/dashboard/credits`), **THEN** thấy: (a) tên gói + trạng thái (active/expired/no-plan); (b) quota 5h và weekly — đã dùng / tổng / % + thời gian reset (nếu có plan, quota>0); (c) RPM của gói + đếm hiện tại trong window 1m; (d) số dư credit; (e) trạng thái toggle `allowCreditOverflow`.
2. **WHEN** API `GET /api/users/me/quota` được gọi (MỚI, auth user-only), **THEN** trả snapshot **read-only** (KHÔNG persist state, KHÔNG 429): `{ source, planName, planExpiresAt, rpm, rpmUsed, quota5h:{limit,consumed,resetAt}, quotaWeekly:{limit,consumed,resetAt}, creditsBalance, allowCreditOverflow }`. quota=0 → trả `limit:0` (UI hiển thị "unlimited"). source=credit/none → plan fields null/0, UI hiển thị "pay-as-you-go".
3. **WHEN** API `GET /api/users/me/ledger?limit&offset&type` được gọi (MỚI, auth user-only), **THEN** trả **chỉ** ledger của `session.userId` (KHÔNG bao giờ user khác) qua `getLedgerByUser`: `{ transactions:[{id,type,bucket,amount,balanceAfter,note,createdAt,...}], ... }`. Phân trang qua limit/offset.
3b. **WHEN** user xem ledger, **THEN** mỗi dòng hiển thị type human-readable (vd `usage_deduction`→"Usage", `[overflow]` note→badge "Overflow", `admin_topup`→"Top-up", `gift_code`→"Gift", `user_payment`→"Payment"), amount (+/− màu xanh/đỏ), thời gian, note.
4. **WHEN** user bật/tắt toggle `allowCreditOverflow` trên UI, **THEN** PATCH `/api/users/me` `{allowCreditOverflow}` (đã có ở 2.14); UI cập nhật optimistic + refetch; có giải thích ngắn ("Khi gói hết quota: bật = tiếp tục bằng credit; tắt = chặn request").
5. **WHEN** user có plan còn quota, **THEN** progress bar mỗi window hiển thị đúng % (consumed/limit), màu cảnh báo khi gần hết (vd >80% vàng, >=100% đỏ), + "reset after Xh Ym" (dùng `formatResetCountdown`). quota=0 → "Unlimited", không bar.
6. **WHEN** user KHÔNG có plan (source=credit) hoặc plan hết hạn, **THEN** UI hiển thị "Pay-as-you-go (credit)" thay vì quota bars; vẫn hiển thị credit balance + ledger. Toggle overflow ẩn hoặc disabled (overflow chỉ có nghĩa khi có plan) — quyết định: **hiển thị nhưng note "chỉ áp dụng khi có gói"**.
7. **WHEN** quota status API lỗi (resolver/DB throw), **THEN** API trả fail-soft (vd `{ source:"error" }` hoặc 200 với plan fields null) — UI hiển thị "không tải được hạn mức, thử lại" thay vì vỡ trang. KHÔNG để lỗi status chặn xem credit/ledger (mỗi card fetch độc lập).
8. **WHEN** role=user only: cả 2 API mới + trang chỉ cho `session.role === "user"` (admin có view riêng). Route trả 403 nếu không phải user session. Sidebar entry chỉ hiện ở `userNavItems`.
9. Full unit suite xanh. Thêm test: `getPlanQuotaStatus` read-only (không persist state — gọi 2 lần state không đổi; consumed đúng; quota=0→unlimited; source=credit→plan null; fail-soft); `/api/users/me/quota` (auth user-only, 403 cho non-user, shape đúng); `/api/users/me/ledger` (chỉ trả ledger session user, phân trang, 403). UI test optional (theo convention dự án — backend API là bắt buộc).

## Tasks / Subtasks

### Phần A — Quota status (read-only) backend (AC#2, #7, #9)
- [ ] **A1**: `src/lib/quota/planQuota.js` (hoặc module mới `planQuotaStatus.js`) → `getPlanQuotaStatus(userId, now=Date.now())`: **READ-ONLY** biến thể của checkPlanQuota — `resolveUserLimits(userId)`; với mỗi window tính `startedAt` qua `resolveWindow(state[key], type, now)` **NHƯNG KHÔNG `setPlanQuotaState`**; `consumed = sumUsageTokensByUser(userId, null, startedAt)`; RPM: đọc `getRpmState(userId)` + `resolveWindow(...,'1m')` (read-only) → rpmUsed. Trả `{ source, planName, planExpiresAt, rpm, rpmUsed, quota5h:{limit,consumed,resetAt}, quotaWeekly:{limit,consumed,resetAt}, allowCreditOverflow }`. Fail-soft try/catch → `{ source:"error" }`.
  - **CRITICAL**: tuyệt đối KHÔNG persist state, KHÔNG trả allowed/429. Đây là khác biệt cốt lõi với `checkPlanQuota`.
- [ ] **A2**: `GET /api/users/me/quota` (`src/app/api/users/me/quota/route.js`): auth `session.role==="user"` (pattern users/me); gọi `getPlanQuotaStatus(session.userId)` + `getUserById` cho creditsBalance/allowCreditOverflow; trả JSON AC#2. 403 nếu non-user.

### Phần B — Ledger history API (AC#3, #8, #9)
- [ ] **B1**: `GET /api/users/me/ledger` (`src/app/api/users/me/ledger/route.js`): auth user-only; parse `limit`(default 50, cap vd 100)/`offset`/`type`; gọi `getLedgerByUser(session.userId, {limit,offset,type})`. **CHỈ** session.userId (KHÔNG nhận userId từ query → chống IDOR). Trả `{ transactions }`. 403 non-user.

### Phần C — users/me GET field (AC#4)
- [ ] **C1**: Kiểm tra `src/app/api/users/me/route.js` GET đã trả `allowCreditOverflow`, `planId`, `planExpiresAt` chưa (2.14 thêm PATCH; GET có thể chưa). Nếu thiếu → thêm vào response GET (đọc từ `getUserById`). KHÔNG đổi PATCH (đã có).

### Phần D — UI page (AC#1, #3b, #4, #5, #6)
- [ ] **D1**: Tạo `src/app/(dashboard)/dashboard/plan/page.js` (`"use client"`): tái dùng pattern `credits/page.js` (Card, skeleton, Tailwind tokens). Fetch song song độc lập: `/api/users/me/quota`, `/api/users/me/ledger?limit=20`, (balance lấy từ quota API hoặc /api/auth/status). Mỗi card lỗi độc lập (AC#7).
- [ ] **D2**: Plan card: tên gói + expiresAt + source badge. Quota bars 5h/weekly (tái dùng `QuotaProgressBar` từ ProviderLimits nếu prop khớp; else component nhỏ tương tự — KHÔNG sửa bản admin). %, màu cảnh báo >80%/>=100%, reset countdown. quota=0→"Unlimited". RPM hiện tại/limit.
- [ ] **D3**: Credit card: balance (tái dùng style credits page). Overflow toggle: switch + giải thích; PATCH `/api/users/me`; optimistic update + refetch quota. source=credit → note "chỉ áp dụng khi có gói".
- [ ] **D4**: Ledger history card: bảng transactions (type human-readable + overflow badge, amount màu, time, note). Phân trang "load more" (offset). Empty state.
- [ ] **D5**: `src/shared/components/Sidebar.js` `userNavItems` → thêm `{ href:"/dashboard/plan", label:"Plan & Quota", icon:"verified" }` (chọn icon material phù hợp). KHÔNG đụng adminItems.

### Phần E — Test (AC#9)
- [ ] **E1**: `tests/unit/plan-quota-status.test.js` — `getPlanQuotaStatus`: (a) read-only — gọi 2 lần, `getPlanQuotaState` không đổi (KHÔNG persist); (b) consumed đúng per window; (c) quota=0 → limit 0 (unlimited); (d) source=credit → plan fields null/0; (e) rpmUsed đọc đúng; (f) fail-soft khi resolver/sum throw → source=error.
- [ ] **E2**: `tests/unit/users-me-quota-api.test.js` — `GET /api/users/me/quota`: user session → shape đúng; non-user/no-session → 403.
- [ ] **E3**: `tests/unit/users-me-ledger-api.test.js` — `GET /api/users/me/ledger`: chỉ trả ledger của session user (seed 2 user, đảm bảo không lẫn); phân trang limit/offset; type filter; 403 non-user.
- [ ] **E4**: Full suite (`NODE_PATH=/tmp/node_modules npm test` từ `tests/`), 0 fail.

## Review Findings

Code review 2026-06-09 (adversarial 3-agent pass) completed; patches applied and verified.

### Applied fixes
- **CRITICAL — RPM used displayed token sum instead of request counter**: `getPlanQuotaStatus` now reads `rpmState.win1m.count` with read-only window resolution, not `sumUsageTokensByUser`.
- **HIGH — non-user roles could render/fetch user quota page**: `/dashboard/plan` now gates on `/api/auth/status` role and redirects non-users to `/dashboard/credits`.
- **MEDIUM — ledger Load more race**: `loadLedger()` sets `ledgerLoading=true` before fetch so repeated clicks cannot issue duplicate offset loads.
- **MEDIUM — overflow toggle stale state**: successful PATCH now refetches quota via `loadQuota()` after optimistic update.
- **LOW — invalid/missing dates rendered as `Invalid Date`**: added `formatDate()` fallback for plan expiry and ledger timestamps.

### Dismissed / accepted
- Ledger type labels have safe fallback via `type?.replaceAll("_", " ") || "Transaction"`.
- Active/expired/no-plan state is already represented by `source` + `planExpiresAt` display.
- No deferred work from this review.

### Verification
- Targeted 2.15 tests: `plan-quota-status`, `users-me-quota-api`, `users-me-ledger-api` — **7 pass / 0 fail**.
- Full suite: **1040 pass / 1 fail**. Failing `xai-oauth-service.test.js` is pre-existing/unrelated network-dependent timeout (committed baseline), not introduced by story 2.15.

## Dev Notes

### CRITICAL — status API KHÔNG side-effect (đọc kỹ)
`checkPlanQuota` (2.14) **persist window state khi reset** (`setPlanQuotaState`) và **trả allowed:false + 429** khi exhausted. API cho UI tuyệt đối KHÔNG được như vậy:
- KHÔNG persist → nếu không, mở trang sẽ "reset" window của user sai thời điểm (tạo window mới khi user chỉ đang xem) → làm lệch enforcement thật.
- KHÔNG chặn → status chỉ là số liệu, không phải admission.
→ Viết `getPlanQuotaStatus` riêng (read-only). Có thể refactor phần "tính consumed per window" thành helper chung mà `checkPlanQuota` và `getPlanQuotaStatus` cùng gọi, nhưng **chỉ `checkPlanQuota` mới persist + chặn**. An toàn nhất: hàm status tự `resolveWindow` (pure) + `sumUsageTokensByUser`, không gọi setter.

### IDOR — ledger/quota chỉ của chính user
2 API mới lấy userId **TỪ SESSION** (`session.userId`), KHÔNG bao giờ từ query/body. Pattern đã đúng ở `users/me/route.js` (dùng `session.userId`). Admin xem ledger user khác là chuyện E.5, KHÔNG ở đây. Test phải seed ≥2 user và khẳng định không rò.

### Tái dùng, KHÔNG reinvent
- Trang theo khuôn `credits/page.js` (Card, skeleton, fetch pattern, Tailwind design tokens). KHÔNG tạo design system mới.
- `QuotaProgressBar` (`usage/components/ProviderLimits/QuotaProgressBar.js`) — đọc props trước; nếu nhận `{consumed, limit}` hay tương tự thì tái dùng; nếu coupling với admin data shape thì viết component nhỏ riêng trong `plan/` (đừng sửa bản admin → tránh regression quota tracker admin).
- `formatResetCountdown(resetAt, now)` (window.js) cho chuỗi "reset after Xh Ym".
- Auth: copy pattern `getSessionUser()` từ `users/me/route.js` (session + role==="user" → 403).

### Số/tiền hiển thị
- credit balance: `$X.XXXX` (4 chữ số như credits page). amount ledger có thể âm (deduction) — màu đỏ; dương — xanh.
- quota token: số lớn → format gọn (vd `1.2M / 2M tokens`) hoặc raw — chọn 1, nhất quán.
- `allowCreditOverflow` từ DB là 0/1 → bool ở API (2.14 rowToUser đã coerce).

### Out of scope (story khác)
- Admin xem/sửa quota user khác, CRUD plan, gán/nâng gói → **E.5** (2-16).
- Mua/gia hạn/đổi gói self-serve → **E.7** (2-18).
- Per-model quota hiển thị/enforce → **E.6** (2-17).
- Enforcement (đã xong E.2/E.3) — story này CHỈ hiển thị + toggle.
- Realtime/websocket cập nhật quota — poll/refetch là đủ MVP.

### Ràng buộc CRITICAL (tóm tắt)
- Status API **read-only** tuyệt đối (no persist, no 429).
- 2 API mới: userId từ **session**, 403 non-user, chống IDOR.
- KHÔNG sửa `checkPlanQuota`/`checkRpmLimit`/enforcement (chỉ thêm hàm status đọc).
- KHÔNG sửa ProviderLimits admin component.
- Tái dùng credits page pattern + design tokens.
- Toggle dùng PATCH /api/users/me đã có (2.14) — không tạo route mới cho toggle.

### References
- [Source: docs/epics-saas.md#Epic E] — E.4: "UI user xem quota/RPM/credit + lịch sử ledger + toggle allowCreditOverflow"; "tái dùng dashboard/usage/components/ProviderLimits"
- [Source: src/app/(dashboard)/dashboard/credits/page.js] — MẪU trang user (Card, fetch, skeleton, design tokens, gift/payment history)
- [Source: src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaProgressBar.js] — progress bar tái dùng
- [Source: src/app/api/users/me/route.js] — auth getSessionUser + role==="user", PATCH allowCreditOverflow (2.14), GET profile
- [Source: src/lib/db/repos/creditLedgerRepo.js#getLedgerByUser] — ledger query (limit/offset/type/bucket)
- [Source: src/lib/quota/resolvePlan.js#resolveUserLimits] — plan limits source
- [Source: src/lib/db/repos/quotaRepo.js#sumUsageTokensByUser + getPlanQuotaState + getRpmState] — consumed + window state (đọc, KHÔNG ghi)
- [Source: src/lib/quota/planQuota.js#checkPlanQuota] — KHÔNG gọi từ status (có side-effect); mẫu logic để viết getPlanQuotaStatus read-only
- [Source: src/lib/quota/window.js#resolveWindow/formatResetCountdown] — window math read-only + reset countdown
- [Source: src/shared/components/Sidebar.js:34 userNavItems] — thêm nav entry user
- [Source: src/app/api/auth/status/route.js] — creditsBalance/role/userId (tham khảo, /users/me là chuẩn)
- [Source: docs/stories/2-14-plan-quota-enforcement.md] — allowCreditOverflow, billingSource, Model B (ngữ cảnh để giải thích toggle cho user)

## Dev Agent Record
### Agent Model Used
Sonnet 4.6
### Debug Log References
- Implemented read-only quota status helper and user-facing quota/ledger APIs.
- Added /dashboard/plan UI + sidebar entry.
- Added unit coverage for helper and APIs.
### Completion Notes List
- Added `getPlanQuotaStatus` read-only snapshot logic with fail-soft behavior.
- Added `GET /api/users/me/quota` and `GET /api/users/me/ledger` user-only routes.
- Added `/dashboard/plan` page with quota, credit, overflow toggle, and ledger views.
- Added sidebar nav entry for users and tests for helper/API coverage.
### File List
- src/lib/quota/planQuotaStatus.js
- src/app/api/users/me/quota/route.js
- src/app/api/users/me/ledger/route.js
- src/app/api/users/me/route.js
- src/app/(dashboard)/dashboard/plan/page.js
- src/shared/components/Sidebar.js
- tests/unit/plan-quota-status.test.js
- tests/unit/users-me-quota-api.test.js
- tests/unit/users-me-ledger-api.test.js
- tests/unit/users-me-overflow.test.js

## Change Log
| Date | Change |
|------|--------|
| 2026-06-08 | Tạo story E.4 (2.15) — User Plan & Quota UI. Trang /dashboard/plan: quota 5h/weekly bars + RPM + credit + ledger history + allowCreditOverflow toggle. 2 API mới (GET /api/users/me/quota read-only no-side-effect, GET /api/users/me/ledger IDOR-safe) + getPlanQuotaStatus read-only helper. Tái dùng credits page pattern + QuotaProgressBar. Phụ thuộc E.1/E.2/E.3/E.3b (done). Status → ready-for-dev. |
| 2026-06-09 | Implemented read-only quota snapshot API, user ledger API, plan dashboard UI, sidebar nav entry, and unit tests. |
