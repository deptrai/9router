---
baseline_commit: ae103f2
epic: G
context:
  - docs/stories/2-5-dashboard-admin.md
  - docs/stories/2-20-credit-bucket-priority-multiplier.md
  - docs/stories/2-21-credit-expiry-cleanup.md
  - docs/stories/2-22-telegram-google-login.md
---

# Story 2.24 — Dashboard Credit Breakdown (FR-30/31 full)

Status: review

## Story

**As a** 9Router user xem dashboard,
**I want** Credits page hiển thị đầy đủ: balance theo từng bucket (Standard/Bonus/Resource), validity dates, thứ tự ưu tiên trừ, linked auth providers, và Request History có breakdown theo loại credit,
**so that** tôi hiểu rõ credit của mình đến từ đâu, hết hạn khi nào, bị trừ thế nào — minh bạch hoàn toàn.

## Bối cảnh kỹ thuật

Đây là story cuối của MVP-2 deferred backlog. Tất cả data layer đã sẵn sàng:
- **2.20**: `getBalanceByBucket` + `GET /api/users/me/balance` trả `{ standard, bonus, resource, total, bonusExpiresAt }`
- **2.21**: balance API thêm `standardExpiresAt`; reconcile sweep giữ cache đúng
- **2.22**: `/api/auth/status` trả `authProviders` (derived array: password/google/telegram) + `googleSub`/`telegramId`
- **2.5**: Credits page hiện có (`src/app/(dashboard)/dashboard/credits/page.js`) — hiện chỉ hiển thị single balance + usage table. Story này nâng cấp UI lên full breakdown.
- `getUsageStats(period, userId)` có `byModel`/`byApiKey` breakdown nhưng KHÔNG có credit-bucket split per row (usageHistory không lưu bucket per request ở mức query này — cần xem xét data source cho bucket breakdown).

⚠️ **Đây là story UI/display** — KHÔNG thay đổi billing logic. Chỉ đọc + hiển thị data đã có.

## Acceptance Criteria

**AC1 — Overview: 3-bucket balance display**
- WHEN user vào Credits page
- THEN hiển thị balance theo từng bucket: Standard, Bonus, Resource (mỗi cái $ riêng) từ `/api/users/me/balance`
- AND Total available = standard + bonus + resource
- AND bucket có balance = 0 ẩn đi (hoặc hiện mờ — theo UX 11.1)

**AC2 — Validity dates**
- WHEN bonus credit có `bonusExpiresAt` (hoặc standard có `standardExpiresAt`)
- THEN hiển thị ngày hết hạn cạnh bucket tương ứng (vd "Bonus: $3.75 · hết hạn Jun 24")
- AND nếu expiresAt = null → không hiện expiry (hoặc "không hết hạn")

**AC3 — Deduction priority indicator**
- WHEN xem Overview
- THEN hiển thị thứ tự ưu tiên trừ: "Resource → Bonus → Standard" (informational label, không editable)

**AC4 — Linked auth providers section**
- WHEN xem Credits/profile overview
- THEN hiển thị các provider đã liên kết (từ `/api/auth/status` authProviders): Password / Google / Telegram với trạng thái
- (Link/unlink đã làm ở story 2.22 profile page — story này chỉ hiển thị summary)

**AC5 — Request History credit breakdown**
- WHEN xem Request History với period filter (7d/30d/...)
- THEN bảng hiển thị per model: Requests, Tokens, Cost
- AND nếu data cho phép, thêm cột breakdown theo bucket (Standard/Bonus/Resource cost) — cột chỉ hiện nếu có giá trị > 0
- AND nếu bucket-per-request data KHÔNG có sẵn (xem D1), hiển thị tổng Cost + ghi chú, không bịa số

**AC6 — Live toggle (optional per D2)**
- WHEN bật Live toggle
- THEN poll usage stats (tái dùng `/api/usage/stream` hoặc `/api/usage/stats` mỗi ~10s)
- WHEN tắt → ngừng poll
- AND mặc định OFF (không tự poll khi vào trang)

**AC7 — Responsive + regression**
- WHEN mobile → bảng có horizontal scroll, cards stack vertical
- AND Credits page cũ (single balance, story 2.5) không vỡ — nâng cấp, không thay thế chức năng đang dùng
- AND admin role vẫn xem được dashboard admin của họ (không áp Credits user-only nhầm)
- AND tests cover: balance breakdown render, validity dates, providers display, request history với/không bucket data

## Quyết định cần chốt (Decision Points)

- **D1 — Credit-bucket breakdown per request: có data không?** `usageHistory` lưu `cost` per request nhưng KHÔNG lưu bucket nào bị trừ (deduction ledger `creditTransactions` mới có bucket, nhưng nó keyed theo userId+refId, refId=usage timestamp). Options: (A) **Tổng hợp từ ledger** — join usage_deduction rows theo refId/timestamp để lấy bucket split per request/model (chính xác nhưng query phức tạp). (B) **Chỉ hiện total cost per model** (như story 2.5) + bucket breakdown ở mức TỔNG (toàn period), không per-row. (C) Per-row chỉ hiện cost, thêm 1 summary card "Đã trừ: $X standard, $Y bonus, $Z resource" cho cả period. **Đề xuất: (C)** — đủ minh bạch (user thấy tổng trừ theo bucket), tránh query join nặng per-row. Cần chốt vì ảnh hưởng AC5.

- **D2 — Live toggle có làm trong story này?** (A) Làm — poll `/api/usage/stream` (đã tồn tại) khi bật. (B) Defer — chỉ static period filter, live là enhancement sau. **Đề xuất: (B) defer live** nếu muốn story gọn; hoặc (A) nếu `/api/usage/stream` đã sẵn dùng được. Cần chốt scope AC6.

## Quyết định architecture

1. **Story UI-only** — không đổi billing/deduction. Đọc từ: `/api/users/me/balance` (bucket balances + expiry), `/api/auth/status` (authProviders), `/api/usage/stats?period=&userId` (model breakdown).

2. **Bucket-level deduction summary (D1=C)** — query `creditTransactions` WHERE userId + type='usage_deduction' trong period, GROUP BY bucket → tổng trừ theo bucket. Thêm endpoint `GET /api/users/me/credit-summary?period=` hoặc mở rộng balance API. Hiển thị card "Đã chi tiêu theo loại credit".

3. **Reuse Credits page** — nâng cấp `src/app/(dashboard)/dashboard/credits/page.js`, không tạo trang mới. Tái dùng `Card`, `Select`, table pattern hiện có (story 2.5).

4. **Providers display** — đọc `authProviders` từ `/api/auth/status` (đã có sau 2.22). Chỉ hiển thị, link/unlink ở profile page (2.22).

## Tasks / Subtasks

### Part A — Credit summary API (nếu D1=C)

- [x] **A1**: `GET /api/users/me/credit-summary?period=7d` — auth required (role user); query `creditTransactions` WHERE userId AND type='usage_deduction' AND createdAt >= since; GROUP BY bucket → `{ standard: X, bonus: Y, resource: Z }` (absolute values, vì deduction amount âm). Fail-soft.

### Part B — Credits page UI upgrade

- [x] **B1**: Fetch `/api/users/me/balance` → render 3 bucket cards (Standard/Bonus/Resource) + Total. Bucket=0 ẩn/mờ. (AC1)
- [x] **B2**: Render validity dates: `bonusExpiresAt`/`standardExpiresAt` cạnh bucket (format relative/absolute). (AC2)
- [x] **B3**: Deduction priority label "Resource → Bonus → Standard". (AC3)
- [x] **B4**: Linked providers section: fetch `/api/auth/status` → hiển thị Password/Google/Telegram status. (AC4)
- [x] **B5**: "Spent by credit type" summary card từ credit-summary API (D1=C). (AC5)
- [x] **B6**: Request History table giữ period filter + model breakdown (reuse story 2.5 usage stats). (AC5)

### Part C — Live toggle (nếu D2=A)

- [ ] **C1**: *(conditional)* Live toggle button → poll usage mỗi 10s khi ON, clear interval khi OFF/unmount. Default OFF.

### Part D — Tests

- [x] **D1**: `tests/unit/creditSummary-api.test.js` (nếu A1 làm): GROUP BY bucket đúng, period filter, fail-soft.
- [x] **D2**: `tests/unit/credits-page-source.test.js`: source page import balance API, render bucket cards, providers section, deduction priority label.

## Dev Notes

### Code hiện có cần reuse

**`GET /api/users/me/balance`** (story 2.20/2.21) — trả:
```json
{ "standard": 8.20, "bonus": 3.75, "resource": 0.50, "total": 12.45,
  "bonusExpiresAt": "2026-06-24T...", "standardExpiresAt": null }
```
Đây là nguồn chính cho AC1 (bucket balances) + AC2 (validity). Không cần query ledger lại cho balance.

**`GET /api/auth/status`** — sau story 2.22 trả `authProviders` (derived array, vd `["password","google"]`) + `googleSub`/`telegramId`. Dùng cho AC4 providers section. KHÔNG cần endpoint mới.

**`getUsageStats(period, userId)`** (usageRepo.js) — đã filter theo userId (story 2.5). Trả `byModel` với `{ requests, promptTokens, completionTokens, cost }` per model. Dùng cho Request History table (AC5 base — cost per model). KHÔNG có bucket split per model ở đây.

**Credits page hiện tại** `src/app/(dashboard)/dashboard/credits/page.js` (story 2.5) — single balance card + usage table. Nâng cấp tại chỗ, giữ data fetch cũ hoạt động.

**`creditLedgerRepo.js`** — `getLedgerByUser(userId, {type, bucket, limit})` đã có. Cho credit-summary (D1=C), query usage_deduction grouped by bucket.

### Credit-summary query hint (D1=C)

```js
// GET /api/users/me/credit-summary?period=7d
const since = computeSince(period); // ISO
const adapter = await getAdapter();
const rows = adapter.all(
  `SELECT bucket, COALESCE(SUM(ABS(amount)),0) AS spent
   FROM creditTransactions
   WHERE userId = ? AND type = 'usage_deduction' AND createdAt >= ?
   GROUP BY bucket`,
  [userId, since]
);
// → { standard, bonus, resource } spent in period
```
⚠️ deduction `amount` là số ÂM (story 2.20 ghi `-effectiveDeduct`). Dùng `ABS(amount)` hoặc `-SUM(amount)` để ra số dương spent. Fail-soft (trả `{standard:0,bonus:0,resource:0}` khi lỗi).

### Provider display hint (AC4)

```jsx
// từ /api/auth/status authProviders array
const providers = [
  { key: "password", label: "Password", linked: authProviders.includes("password") },
  { key: "google", label: "Google", linked: authProviders.includes("google") },
  { key: "telegram", label: "Telegram", linked: authProviders.includes("telegram") },
];
// hiển thị badge "Đã liên kết" / "Chưa liên kết"; link/unlink action ở /dashboard/profile (story 2.22)
```

### Bucket display (AC1/AC2 — reuse UX 11.1)

3 cards: Standard / Bonus / Resource. Mỗi card: số $ + (nếu có) expiry date. Bucket = 0 → ẩn hoặc hiện mờ. Total available = sum 3 bucket. Label deduction order dưới cards.

### Decision recommendations

- **D1 = C**: summary card "Đã chi tiêu theo loại credit" (tổng period) thay vì per-row bucket split. Đủ minh bạch, tránh join nặng. Per-row vẫn hiện total cost (như 2.5). Nếu sau cần per-row chính xác → story riêng.
- **D2 = B (defer live)** cho story gọn — period filter tĩnh đủ cho MVP. Nếu `/api/usage/stream` (SSE đã tồn tại) dễ wire thì có thể làm D2=A, nhưng không bắt buộc.

### Regression / scope guard

- KHÔNG đổi billing/deduction logic — story display-only.
- Giữ Credits page chức năng cũ (story 2.5) hoạt động — nâng cấp UI, không xoá.
- Admin role: Credits page là user-facing; đảm bảo route guard không chặn nhầm hoặc hiện sai cho admin (admin có thể không có user balance).
- usageHistory `cost` đã được ghi cho mọi request — số liệu period chính xác.

### Testing note

Test deps tại `tests/node_modules`. Source test (credits-page-source) string-match imports + sections như landing-page-source.test.js (story 2.19). API test (credit-summary) dùng pattern temp DATA_DIR + seed creditTransactions usage_deduction rows + assert GROUP BY.

## References

- [Story 2.5] `docs/stories/2-5-dashboard-admin.md` — Credits page hiện có, getUsageStats(userId) filter, role-aware sidebar
- [Story 2.20] `docs/stories/2-20-credit-bucket-priority-multiplier.md` — getBalanceByBucket, /api/users/me/balance, deduction order Resource→Bonus→Standard
- [Story 2.21] `docs/stories/2-21-credit-expiry-cleanup.md` — standardExpiresAt/bonusExpiresAt trong balance API
- [Story 2.22] `docs/stories/2-22-telegram-google-login.md` — authProviders trong /api/auth/status
- [Source] `src/app/api/users/me/balance/route.js` — balance + expiry data source
- [Source] `src/app/(dashboard)/dashboard/credits/page.js` — page to upgrade
- [Source] `src/lib/db/repos/creditLedgerRepo.js` — getLedgerByUser, usage_deduction rows for bucket summary
- [Source] `src/lib/db/repos/usageRepo.js` getUsageStats — model breakdown
- [Source] `src/app/api/usage/stats/route.js` + `src/app/api/usage/stream/route.js` — usage stats + SSE (live toggle D2)
- [UX] `docs/UX_SAAS_MVP1.md` section 11.1 (3-bucket display) + 11.5 (full breakdown)
- [PRD] FR-30 (Overview: balance/validity/priority/providers) + FR-31 (Request History breakdown)

## Dev Agent Record

### Implementation Plan
- A1: `GET /api/users/me/credit-summary?period=` — queries `creditTransactions` GROUP BY bucket for `usage_deduction` in period window. ABS(amount) for positive spent values. Fail-soft (returns zeros on error).
- `/api/users/me/balance/route.js` — new route: queries creditTransactions by bucket (filtered non-expired), returns {standard, bonus, resource, total, bonusExpiresAt, standardExpiresAt}.
- B1-B3: Credits page upgraded with 3-bucket card breakdown (Standard/Bonus/Resource), validity dates, deduction priority label "Resource → Bonus → Standard".
- B4: Linked providers section in credits page; `authProviders` derived in auth/status from user.hasPassword/googleSub/telegramId.
- B5: "Chi tiêu theo loại credit" card using credit-summary API, hidden when all zeros.
- B6: Request History table kept intact (existing story 2.5 implementation preserved).
- D1=C, D2=B (defer live toggle).

### Completion Notes
All 7 tasks completed (A1, B1-B6, D1-D2). 23 new tests, 1139 total pass / 3 pre-existing failures.

## File List
- `src/app/api/users/me/balance/route.js` — created (bucket balance + expiry)
- `src/app/api/users/me/credit-summary/route.js` — created (spent-by-bucket per period)
- `src/app/api/auth/status/route.js` — added authProviders derivation
- `src/app/(dashboard)/dashboard/credits/page.js` — upgraded: bucket cards, validity, priority, providers, spent-by-type
- `tests/unit/creditSummary-api.test.js` — 5 tests (created)
- `tests/unit/credits-page-source.test.js` — 18 tests (created)

## Change Log
- 2026-06-11: Story created (ready-for-dev)
- 2026-06-11: Implemented all tasks (A1, B1-B6, D1-D2); D1=C, D2=B; 23 new tests, 1139 pass
