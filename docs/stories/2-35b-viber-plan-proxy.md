---
baseline_commit: ebb95c6
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - src/lib/db/schema.js
  - src/lib/store/storeCheckout.js
  - src/lib/db/repos/credentialsRepo.js
  - docs/stories/2-26-telegram-checkout-orders.md
  - docs/stories/2-29b-entitlement-routing.md
---

# Story 2.35b: viber.vn Plan Proxy (Claude Plans via Proxy)

Status: ready-for-dev

## Story

As a **user của 9Router**,
I want **mua gói Claude theo thời gian (ngày/tuần/tháng) từ viber.vn qua 9Router store**,
so that **tôi dùng Claude không giới hạn model choice trong quota ngày/tuần, trả bằng credit 9Router, nhận key tự động và dùng ngay qua proxy**.

## Bối cảnh và quyết định architecture

> **Story này tích hợp viber.vn như một plan proxy provider.** viber.vn bán gói Claude dạng account có quota ngày/tuần (250$/day, 500$/day...). 9Router mua gói thay user (dùng JWT viber của 9Router), nhận `sk-vibervn-...` key + base URL, lưu vào DB, và proxy request Claude của user sang viber. Khác với v98store (pay-as-you-go), viber là plan-based với quota cứng.

### Research findings (verified 2026-06-15 — live browser session)

**viber.vn API** (verified qua network inspection, auth: `Authorization: Bearer <JWT>`):

```
GET  /api-packages                    → list gói + stock_count, in_stock, price_vnd
GET  /api-packages/my-purchases       → gói đã mua: { api_key, base_url, dashboard_url, purchased_at }
POST /api-packages/{id}/purchase      → mua gói → trả { api_key, base_url, dashboard_url }
GET  /balances                        → { balance (VND), username }
GET  /api/user/profile                → { username, telegram_username }
POST /api/auth/refresh                → refresh JWT
```

**Gói hiện có (2026-06-15):**
| Tên | Giá VND | Quota/day | Quota/week | Stock |
|-----|---------|-----------|------------|-------|
| Gói Claude Ngày - 250USD | 150,000 | $250 | - | 7 |
| Gói Claude Tuần 250$/day | 300,000 | $250 | $1,200 | 2 |
| Gói Claude Tuần 500$/day | 600,000 | $500 | $2,500 | 0 |
| Gói Claude Tháng 150$/day | 1,000,000 | $150 | $800 | 5 |
| Gói Claude Tháng 250$/day | 1,200,000 | $250 | $1,200 | 4 |
| Gói Claude Tháng 500$/day | 2,400,000 | $500 | $2,500 | 3 |
| Gói $5000/30 days (server riêng) | 1,200,000 | - | - | 0 |

**Key format sau purchase**: `sk-vibervn-<random>`, `base_url: https://fallback.viber.vn`
**Auth viber là Anthropic-compatible** (Claude only): endpoint `https://fallback.viber.vn`

**Purchase dialog confirmed**: `POST /api-packages/{id}/purchase` — button disabled khi balance=0, không thể trigger thật nhưng endpoint đã verify từ JS bundle (`ra` function trong `ApiPackagesPage-BcaUoHkV.js`)

### Hiện trạng code (verified tại baseline ebb95c6)

- **`entitlements` table** (story 2.29a/2.29b): `userId, productId, connectionId, status`. Entitlement routing đã có — user có entitlement → route request qua connection tương ứng. Đây là pattern tái dùng cho viber.
- **`connections` table**: lưu `apiKey` (encrypted), `baseUrl`, `provider`. viber key sẽ là 1 connection.
- **`storeCheckout.js`**: instant delivery + credential pattern (2.27). Viber không dùng credential pattern — dùng entitlement/connection pattern (2.29b).
- **`ordersRepo.js`**: ORDER_STATUSES, `transitionOrderSync`. Tái dùng cho viber order flow.
- **`creditLedgerRepo.js`**: `recordCreditTxn`, `reverseTxn`. Tái dùng cho billing.

### Quyết định architecture

- **QĐ1 — viber plan = entitlement + connection**: Khi user mua gói viber qua 9Router → 9Router gọi viber `POST /api-packages/{id}/purchase` → nhận `sk-vibervn-...` → tạo `connection` (provider=viber, apiKey encrypted, baseUrl=https://fallback.viber.vn) → tạo `entitlement` gắn userId + connectionId. Routing engine (2.29b) tự động dùng entitlement này khi user request Claude.
- **QĐ2 — viber JWT của 9Router là service account**: 9Router có 1 viber account (epsilonai đã login). JWT lưu trong env (`VIBER_JWT`, `VIBER_REFRESH_TOKEN`). Auto-refresh khi hết hạn (POST /api/auth/refresh). KHÔNG phải mỗi user có viber account riêng.
- **QĐ3 — Catalog sync định kỳ**: `GET /api-packages` → upsert vào `viberPackages` table local (name, price_vnd, stock_count, in_stock, viberPackageId). Sync mỗi 15 phút hoặc on-demand. Tương tự `runDuePolls` pattern của 2.30.
- **QĐ4 — Pricing: VND → credit 9Router**: Admin config tỷ lệ VND→credit (vd 1 VND = X credit hoặc admin set giá riêng). Mặc định: map 1:1 với giá VND của viber + markup admin. Lưu trong `viberPackages.priceCredits`.
- **QĐ5 — Expiry tracking**: Viber không trả `expiresAt` trực tiếp trong purchase response. Tính từ `purchased_at` + duration (ngày/tuần/tháng parse từ package name). Lưu vào `entitlements.expiresAt` (REUSE 2.29a — xem T1). Entitlement routing (2.29b) check expiry.
- **QĐ6 — Không sửa storeCheckout.js**: Viber plan mua qua flow riêng (viberCheckout), không phải credential FIFO. Checkout viber = gọi API viber + tạo entitlement, không phải reserve credential từ kho.
- **QĐ7 — Fallback khi viber hết stock**: Nếu `POST /purchase` trả lỗi (out of stock) sau khi user đã trừ credit → rollback credit (reverseTxn) + notify user. Idempotent: không charge nếu purchase thất bại.
- **QĐ8 — Trang `/plans` public**: Next.js page hiển thị gói viber hiện có, giá, quota. Sync từ local cache. CTA mua → Telegram bot hoặc web checkout.

## Acceptance Criteria

### AC1 — Catalog sync viber packages
**Given** `VIBER_JWT` configured
**When** `syncViberPackages()` chạy (cron 15 phút hoặc manual)
**Then** `GET /api-packages` viber → upsert vào `viberPackages` table
**And** `stock_count`, `in_stock`, `price_vnd` được cập nhật
**And** gói hết hàng (`in_stock=false`) vẫn hiển thị nhưng không thể mua

### AC2 — User mua gói viber qua 9Router (Telegram store hoặc web)
**Given** user có đủ credit 9Router (quy đổi từ priceCredits của gói)
**When** user chọn mua gói viber (qua Telegram bot `/products` hoặc web store)
**Then** trong 1 transaction:
  - Trừ credit user (`recordCreditTxn` type=`store_purchase`)
  - Gọi `POST /api-packages/{viberPackageId}/purchase` với viber JWT của 9Router
  - Nhận `api_key` + `base_url` từ viber
  - Tạo `connection` (apiKey encrypted, baseUrl, provider=viber)
  - Tạo `entitlement` (userId, connectionId, expiresAt)
  - Order `paid→fulfilled`
**And** nếu viber purchase thất bại → rollback credit (reverseTxn), order `paid→failed`, thông báo user
**And** user nhận key + hướng dẫn qua Telegram private chat

### AC3 — Proxy Claude request qua viber key
**Given** user có viber entitlement active (chưa hết hạn, chưa hết quota)
**When** user gọi `/v1/messages` hoặc `/v1/chat/completions` với Claude model
**Then** routing engine (2.29b) chọn viber connection của user
**And** proxy request sang `https://fallback.viber.vn` với `sk-vibervn-...`
**And** stream response về user bình thường
**And** nếu viber trả 429 (quota exceeded) → trả lỗi rõ ràng "Daily/weekly quota exceeded"

### AC4 — Expiry handling
**Given** viber entitlement đã hết hạn (expiresAt < now)
**When** user request Claude
**Then** routing engine không dùng entitlement hết hạn
**And** user nhận lỗi "Plan expired — mua gia hạn để tiếp tục"
**And** entitlement cũ đổi status `expired`

### AC5 — viber JWT auto-refresh
**Given** `VIBER_JWT` hết hạn
**When** 9Router cần gọi viber API (purchase hoặc sync)
**Then** tự động `POST /api/auth/refresh` với refresh token
**And** lưu JWT mới vào config
**And** retry request gốc với JWT mới
**And** nếu refresh thất bại → alert admin, KHÔNG crash service

### AC6 — Trang public `/plans`
**Given** visitor truy cập `9router.xyz/plans`
**When** trang load
**Then** hiển thị các gói Claude viber: tên, giá (VND + credit 9Router), quota ngày/tuần, stock
**And** gói hết hàng hiển thị "Hết hàng" disabled
**And** CTA "Mua ngay" → Telegram bot hoặc web checkout
**And** section giải thích: "Claude plan = dùng Claude không lo token, quota reset theo ngày/tuần"

### AC7 — Admin: sync manual + viber balance check
**Given** admin vào admin panel
**When** vào section "viber.vn"
**Then** thấy balance VND của account viber (từ `GET /balances`)
**And** nút "Sync packages" → trigger syncViberPackages()
**And** list gói + stock hiện tại
**And** list entitlements đang active của users

### AC8 — Backward compat
**Given** toàn bộ thay đổi 2.35b
**When** chạy full test suite
**Then** entitlement routing 2.29b không thay đổi với entitlement loại khác
**And** storeCheckout credential flow 2.27 không thay đổi
**And** v98store provider (2.35a) không bị ảnh hưởng

### AC9 — Routing priority viber > v98store (FR91 — owner: story này)
**Given** user request Claude model và CÓ cả viber entitlement active LẪN v98store balance > 0
**When** routing engine chọn đường
**Then** ưu tiên viber entitlement (plan đã trả trước) — dùng viber connection
**And** nếu viber 429 (hết quota) hoặc hết hạn → fallback sang v98store balance (nếu có)
**And** **guard độc lập**: nếu CHỈ 1 layer tồn tại (chỉ viber HOẶC chỉ v98store) → dùng layer đó, KHÔNG cần layer kia hiện diện (story 2.35a và 2.35b ship độc lập được — không hard-depend lẫn nhau)
**And** nếu KHÔNG có cả hai → đi đường billing hiện tại (plan quota / credit, story 2.4/2.14 — KHÔNG regression)

## Tasks / Subtasks

- [ ] **T1 — Schema** (QĐ1, QĐ3) — **CHỐT: tái dùng `entitlements`, KHÔNG tạo `viberEntitlements`**
  - [ ] `viberPackages` table (NEW — catalog cache): `id, viberPackageId, name, description, priceVnd, priceCredits, stockCount, inStock, durationDays, quotaDayUsd, quotaWeekUsd, lastSyncedAt, isActive`
  - [ ] **Viber plan = `entitlements` row** (REUSE 2.29a, KHÔNG bảng mới): `provider='viber'`, `productId`=product viber tương ứng, `providerConnectionId`=connection chứa `sk-vibervn-...`, `expiresAt` (parse từ tên gói), `status` (`active|expired|revoked`), `routePolicy='owned_only'`. Lý do: `entitlements` đã giải đúng bài "user sở hữu connection-backed product có expiry" (2.29a/2.29b) — thêm `viberEntitlements` = duplicate, vi phạm Rule of Three.
  - [ ] KHÔNG cần migration cho entitlements (cột đã đủ). Chỉ migration thêm `viberPackages` table.

- [ ] **T2 — `src/lib/store/viberClient.js`** (NEW) (AC1, AC2, AC5, QĐ2)
  - [ ] `getViberJwt()`: đọc từ env/DB, auto-refresh nếu hết hạn (`POST /api/auth/refresh`)
  - [ ] `syncViberPackages()`: `GET /api-packages` → upsert vào `viberPackages`
  - [ ] `purchaseViberPackage(packageId)`: `POST /api-packages/{id}/purchase` → trả `{ apiKey, baseUrl }`
  - [ ] `getViberBalance()`: `GET /balances` → trả balance VND
  - [ ] Fail-soft: wrap mọi call, retry 1 lần, alert nếu thất bại liên tục

- [ ] **T3 — `src/lib/store/viberCheckout.js`** (NEW) (AC2, QĐ6, QĐ7)
  - [ ] `checkoutViberPlan(userId, viberPackageId, db)`:
    - Validate package in_stock
    - `db.transaction()`: recordCreditTxn + purchaseViberPackage + createConnection + createViberEntitlement + createOrder(paid→fulfilled)
    - Nếu purchaseViberPackage thất bại: throw → rollback toàn bộ txn
  - [ ] Idempotent: check order đã exist trước khi tạo mới
  - [ ] `parseExpiresAt(packageName, purchasedAt)`: parse "Ngày/Tuần/Tháng" từ tên gói → tính expiresAt

- [ ] **T4 — Routing integration** (AC3, AC4, AC9, QĐ1, FR91)
  - [ ] Trong entitlement routing (2.29b): thêm case `type='viber_plan'`, check `expiresAt`
  - [ ] Khi route sang viber: dùng `baseUrl=https://fallback.viber.vn`, `apiKey=sk-vibervn-...`
  - [ ] 429 từ viber → trả lỗi quota exceeded rõ ràng (không retry)
  - [ ] Hết hạn → mark entitlement expired, trả lỗi
  - [ ] **Priority resolver (FR91, owner story này)**: viber active > v98store balance > plan/credit hiện tại. Guard độc lập: chỉ 1 layer tồn tại → dùng layer đó; KHÔNG hard-depend 2.35a (nếu v98store chưa ship, viber vẫn route được, fallback về plan/credit). viber 429/expired → thử v98store (nếu có) → plan/credit.

- [ ] **T5 — API routes** (AC1, AC6, AC7)
  - [ ] `GET /api/store/viber/packages` — public, trả danh sách gói từ cache
  - [ ] `POST /api/store/viber/checkout` — auth, body `{ packageId }`, gọi `checkoutViberPlan`
  - [ ] `GET /api/store/viber/my-plans` — auth, trả entitlements của user
  - [ ] `POST /api/admin/viber/sync` — admin only, trigger syncViberPackages
  - [ ] `GET /api/admin/viber/balance` — admin only, trả viber balance VND

- [ ] **T6 — Telegram bot integration** (AC2)
  - [ ] Thêm viber plans vào `/products` bot command (bên cạnh store products hiện có)
  - [ ] Delivery message sau purchase: key `sk-vibervn-...` + base URL + hướng dẫn dùng với Claude Code/Cursor
  - [ ] KHÔNG log key trong server logs

- [ ] **T7 — Trang public `/plans`** (AC6, QĐ8)
  - [ ] `src/app/plans/page.tsx` (NEW): Next.js ISR, revalidate 900s (15 phút)
  - [ ] Cards gói: tên, quota ngày/tuần, giá VND, giá credit, stock badge
  - [ ] Hết hàng = card mờ + "Hết hàng"
  - [ ] Section "Cách dùng": proxy endpoint, setup Cursor/Claude Code với key
  - [ ] CTA "Mua qua Telegram" → `t.me/9routerbot?start=buy_viber_{packageId}`

- [ ] **T8 — Tests** (AC1–AC9)
  - [ ] `tests/unit/viberClient.test.js` (NEW): mock fetch; syncPackages upsert; purchasePackage success/fail; JWT refresh; balance
  - [ ] `tests/unit/viberCheckout.test.js` (NEW): checkout success (credit deduct + connection + entitlement + order); rollback khi purchase fail; idempotent; parseExpiresAt ngày/tuần/tháng
  - [ ] `tests/unit/viberRouting.test.js` (NEW, AC9/FR91): viber active + v98store balance → chọn viber; viber 429/expired → fallback v98store; chỉ viber → dùng viber; chỉ v98store → dùng v98store; không có cả hai → plan/credit (no regression)
  - [ ] Regression: entitlement routing 2.29b không thay đổi với non-viber entitlements

## Dev Notes

### Ràng buộc bắt buộc

- **KHÔNG log sk-vibervn-... key** — giao qua Telegram private chat, không bao giờ return trong list API hay log server
- **KHÔNG sửa storeCheckout.js** (QĐ6) — viber dùng viberCheckout riêng
- **Rollback an toàn** (QĐ7): nếu viber purchase API thất bại sau khi đã trừ credit → reverseTxn. Không bao giờ để user mất tiền mà không nhận key.
- **viber chỉ support Claude**: routing chỉ dùng viber entitlement cho Claude models. GPT/Gemini/Grok phải dùng v98store (2.35a) hoặc provider khác.
- **JWT viber là credential nhạy cảm**: lưu trong env, không commit, không log

### Ví dụ purchase response viber (inferred từ my-purchases):

```json
{
  "api_key": "sk-vibervn-g6Ap2YeArlPFNm5Re3itJ8mm",
  "base_url": "https://fallback.viber.vn",
  "dashboard_url": "https://fallback.viber.vn/#/usage/sk-vibervn-..."
}
```

### Parse expiry từ tên gói:

```
"Gói Claude Ngày - 250USD"           → +1 ngày
"Gói Claude Tuần (limit ...)"        → +7 ngày
"Gói Claude Tháng (limit ...)"       → +30 ngày
"Gói Claude $5000 30 days"           → +30 ngày
```

### Routing priority

Khi user request Claude model và có cả viber entitlement active + v98store balance:
- Ưu tiên viber entitlement (đã trả tiền plan, nên dùng trước)
- Fallback sang v98store nếu viber hết quota (429) hoặc hết hạn

### Files sẽ chạm

- `src/lib/db/schema.js` — MODIFY (CHỈ thêm `viberPackages` table; `entitlements` REUSE 2.29a, KHÔNG thêm bảng mới)
- `src/lib/store/viberClient.js` — NEW
- `src/lib/store/viberCheckout.js` — NEW
- `src/app/api/store/viber/packages/route.js` — NEW
- `src/app/api/store/viber/checkout/route.js` — NEW
- `src/app/api/store/viber/my-plans/route.js` — NEW
- `src/app/api/admin/viber/sync/route.js` — NEW
- `src/app/api/admin/viber/balance/route.js` — NEW
- `src/app/plans/page.tsx` — NEW (public)
- `src/lib/store/entitlementRouting.js` — MODIFY (thêm viber plan case)
- Telegram bot handler — MODIFY (thêm viber products)
- `tests/unit/viberClient.test.js` — NEW
- `tests/unit/viberCheckout.test.js` — NEW

### KHÔNG được chạm

- `src/lib/store/storeCheckout.js` — hot path
- `src/lib/store/catalogSync.js` — external store sync (2.30–2.34)
- `open-sse/providers/` — viber không phải OpenAI-provider, là proxy
- `src/lib/db/repos/creditLedgerRepo.js` — chỉ GỌI

### Testing standards

- Vitest từ `tests/`: `cd tests && npm test -- unit/<file>.test.js`
- Mock `fetchWithTimeout`/`fetch` cho viber API
- Setup: VIBER_JWT=test-jwt, STORE_ENC_KEY, temp DATA_DIR

### References

- [viber.vn API verified]: GET /api-packages, POST /api-packages/{id}/purchase, GET /api-packages/my-purchases, GET /balances
- [Source: src/lib/store/entitlementRouting.js] — pattern 2.29b để tích hợp
- [Source: src/lib/db/repos/creditLedgerRepo.js] — recordCreditTxn, reverseTxn
- [Source: src/lib/db/repos/ordersRepo.js] — ORDER_STATUSES, transitionOrderSync
- [Source: docs/stories/2-29b-entitlement-routing.md] — entitlement pattern
- [Source: docs/stories/2-26-telegram-checkout-orders.md] — Telegram delivery pattern

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (BMAD Create Story — research + design 2026-06-15)

### Completion Notes List

### File List
