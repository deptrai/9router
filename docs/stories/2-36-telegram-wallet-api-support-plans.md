---
baseline_commit: f2fc6fa
epic: D
context:
  - src/lib/telegram/router.js
  - src/lib/telegram/botClient.js
  - src/lib/db/repos/creditLedgerRepo.js
  - src/lib/db/repos/apiKeysRepo.js
  - src/lib/db/repos/plansRepo.js
  - src/lib/db/repos/productsRepo.js
  - src/lib/db/repos/usersRepo.js
  - src/lib/plans/planPurchase.js
  - src/lib/store/storeCheckout.js
---

# Story 2-36: Telegram Bot — Ví, API Keys, Hỗ trợ, và Plan Products

Status: review

## Story

As a **người dùng Telegram của 9Router**,
I want **xem số dư ví, quản lý API key, xem thông tin hỗ trợ, và mua gói cước trực tiếp qua bot**,
so that **tôi có thể tự phục vụ hoàn toàn qua Telegram mà không cần vào web dashboard**.

## Bối cảnh và quyết định architecture

### Hiện trạng (tại baseline f2fc6fa)

- `/wallet`, `/api`, `/support` đang là `handleStub` — gửi placeholder text, không có logic.
- `handleUpdate` callback dispatcher cũng stub cho `cmd:wallet`, `cmd:api`, `cmd:support`.
- Plan products chưa tồn tại trong bảng `products` — `/products` không hiển thị gói cước.
- Toàn bộ infrastructure đã sẵn sàng: `getBalanceByBucket`, `getLedgerByUser`, `getApiKeysByUser`, `createApiKey`, `updateApiKey`, `listPlans`, `purchasePlanForUser`.

### Quyết định architecture

**QĐ1 — Tất cả logic nằm trong `router.js`, không tạo module mới.**
Các handler mới (`handleWallet`, `handleApi`, `handleSupport`) theo đúng pattern hiện tại: `sendMessage` + `inline_keyboard` + HTML.

**QĐ2 — `/wallet` hiển thị số dư từ `getBalanceByBucket` (per-bucket), KHÔNG dùng `user.creditsBalance` cache.**
`getBalanceByBucket` là nguồn chính xác. 5 giao dịch gần nhất từ `getLedgerByUser(userId, { limit: 5 })`.

**QĐ3 — Plan status trong `/wallet`: đọc `user.planId` + `user.planExpiresAt` + JOIN qua `getPlanById`.**

**QĐ4 — `/api` tạo key qua `createApiKey` với `machineId = String(telegramId)`.**

**QĐ5 — Toggle active/inactive dùng `updateApiKey(id, { isActive: !key.isActive })`.** Callback data: `apitog:{keyId}`. Không implement delete qua bot.

**QĐ6 — `/support` đọc `TELEGRAM_SUPPORT_USERNAME` và `FAQ_URL` từ env (runtime).** Fallback graceful nếu chưa set.

**QĐ7 — Plan products: tạo bằng seed script, KHÔNG hardcode trong router.** Script idempotent tạo rows vào `products` với `kind: "plan"`, `targetType: "9router_plan"`, `targetId: <planId>`, `deliveryMode: "instant"`, `stock: null`.

**QĐ8 — Plan checkout hook trong `storeCheckout.js`:** sau khi order commit, nếu `product.kind === "plan"` → gọi `purchasePlanForUser({ userId, planId: product.targetId, idempotencyKey })`. Attach result vào return object.

**QĐ9 — Known limitation:** order commit trước plan activate. Nếu `purchasePlanForUser` fail sau credit trừ → admin can thiệp thủ công. Acceptable at current scale.

## Acceptance Criteria

### AC1 — /wallet: hiển thị số dư và lịch sử giao dịch

**Given** user gõ `/wallet` hoặc nhấn nút "💰 Ví" từ MAIN_MENU
**When** bot nhận command/callback
**Then**
- Hiển thị số dư 3 bucket: `standard`, `bonus`, `resource` (credits)
- Hiển thị 5 giao dịch gần nhất: type, amount (+ hoặc -), ngày tạo
- Hiển thị trạng thái gói cước hiện tại: tên plan + ngày hết hạn, hoặc "Chưa có gói" nếu `planId` null
- Có nút "💳 Nạp tiền" dạng URL button trỏ tới `${BASE_URL}/dashboard/credits`
- Nếu user chưa tồn tại trong DB, gửi "Vui lòng /start trước"

### AC2 — /wallet: trường hợp không có giao dịch

**Given** user mới tạo chưa có giao dịch nào
**When** gọi `/wallet`
**Then** hiển thị số dư 0 và dòng "Chưa có giao dịch gần đây"

### AC3 — /api: hiển thị danh sách API key

**Given** user gõ `/api` hoặc nhấn nút "🔑 API"
**When** bot nhận command/callback
**Then**
- Liệt kê keys: tên, masked key (`****${key.slice(-8)}`), trạng thái (✅/⛔)
- Mỗi key có nút toggle callback `apitog:{keyId}`
- Nếu count < 10: nút "➕ Tạo key mới" callback `apicreate`
- Nếu đã 10 key: thông báo đạt giới hạn
- Nếu chưa có key: "Chưa có API key" + nút tạo mới

### AC4 — /api: tạo key mới

**Given** user nhấn "➕ Tạo key mới" (callback `apicreate`)
**When** bot xử lý callback
**Then**
- Gọi `createApiKey(name, machineId, userId)` với `machineId = String(telegramId)`, `name = "tg-${telegramId}"`
- Gửi full key trong `<code>` 1 lần duy nhất + cảnh báo lưu lại
- Nếu đã đủ 10: gửi "Đã đạt giới hạn 10 API key"

### AC5 — /api: toggle active/inactive

**Given** user nhấn toggle (callback `apitog:{keyId}`)
**When** bot xử lý callback
**Then**
- Verify `key.userId === user.id` trước khi update
- Gọi `updateApiKey(keyId, { isActive: !key.isActive })`
- Gửi xác nhận "Key đã được [bật/tắt]"
- Nếu key không thuộc user: "Không tìm thấy key"

### AC6 — /support: hiển thị thông tin hỗ trợ

**Given** user gõ `/support` hoặc nhấn "🆘 Hỗ trợ"
**When** bot nhận command/callback
**Then**
- Hiển thị hướng dẫn sử dụng các lệnh bot
- Nếu `TELEGRAM_SUPPORT_USERNAME` set: nút URL "💬 Chat admin" → `https://t.me/{username}`
- Nếu `FAQ_URL` set: nút URL "📖 FAQ"
- Không throw nếu env chưa set

### AC7 — Plan products hiện trong /products

**Given** admin đã seed plan products (`kind: "plan"`, `targetType: "9router_plan"`, `targetId: <planId>`)
**When** user gọi `/products`
**Then** plan products hiển thị cùng sản phẩm khác, có nút "Mua ngay", stock "Không giới hạn"

### AC8 — Plan checkout: mua plan qua bot

**Given** user xác nhận mua plan product (callback `buyc:{productId}`)
**When** `handleBuyExecute` chạy
**Then**
- `storeCheckout` tạo order + debit credits
- Sau order commit: gọi `purchasePlanForUser({ userId, planId: product.targetId, idempotencyKey })`
- Gửi xác nhận plan kích hoạt + ngày hết hạn
- Handle `PlanPurchaseError` codes: `PLAN_NOT_FOUND`, `INSUFFICIENT_CREDITS`
- Idempotency replay: trả đơn cũ, không kích hoạt lại

### AC9 — Error isolation

**Given** lỗi trong bất kỳ handler mới nào
**When** error throw
**Then** catch nội bộ, `console.error`, gửi message gợi ý `/support`, `handleUpdate` vẫn resolve

## Tasks / Subtasks

- [x] **T1 — Implement `handleWallet`** (AC1, AC2, AC9)
  - [x] Import `getBalanceByBucket`, `getLedgerByUser` từ `creditLedgerRepo.js`
  - [x] Import `getPlanById` từ `plansRepo.js`
  - [x] Lookup user → guard not found
  - [x] Format HTML: số dư 3 bucket + giao dịch + plan status
  - [x] URL button "💳 Nạp tiền" → `${BASE_URL}/dashboard/credits`

- [x] **T2 — Implement `handleApi`, `handleApiCreate`, `handleApiToggle`** (AC3, AC4, AC5, AC9)
  - [x] Import `getApiKeysByUser`, `createApiKey`, `updateApiKey` từ `apiKeysRepo.js`
  - [x] `handleApi`: list masked keys + toggle buttons + create button
  - [x] `handleApiCreate`: create key, send full key in `<code>`, catch KEY_LIMIT
  - [x] `handleApiToggle`: verify ownership, toggle, confirm

- [x] **T3 — Implement `handleSupport`** (AC6, AC9)
  - [x] Read `TELEGRAM_SUPPORT_USERNAME` + `FAQ_URL` at runtime
  - [x] Build message + URL buttons (conditional)

- [x] **T4 — Wire handlers vào dispatcher** (AC1, AC3, AC6)
  - [x] Replace `handleStub` calls with real handlers in switch
  - [x] Add callback cases: `cmd:wallet`, `cmd:api`, `cmd:support`, `apicreate`, `apitog:`

- [x] **T5 — Plan checkout hook trong `storeCheckout.js`** (AC8)
  - [x] Import `purchasePlanForUser`, `PlanPurchaseError`
  - [x] After order commit: check `product.kind === "plan"` → call `purchasePlanForUser`
  - [x] Attach `planActivation` to result

- [x] **T6 — Plan activation message trong `handleBuyExecute`** (AC8)
  - [x] Check `result.planActivation` → send activation confirmation
  - [x] Handle `PlanPurchaseError` in catch block

- [x] **T7 — Seed plan products** (AC7)
  - [x] Create `src/lib/db/seeds/planProducts.js`
  - [x] For each active plan: create product if not exists (`targetId` match)
  - [x] Idempotent, can run multiple times safely

- [x] **T8 — Tests** (all ACs)
  - [x] Unit tests for each handler (mock repos)
  - [x] Integration test for plan checkout path (existing storeCheckout tests pass with plan hook)

## Dev Notes

### Files chính
- `src/lib/telegram/router.js` — T1–T4, T6
- `src/lib/store/storeCheckout.js` — T5
- `src/lib/db/seeds/planProducts.js` — T7 (NEW)

### Imports mới cho router.js
```js
import { getBalanceByBucket, getLedgerByUser } from "../db/repos/creditLedgerRepo.js";
import { getApiKeysByUser, createApiKey, updateApiKey } from "../db/repos/apiKeysRepo.js";
import { getPlanById } from "../db/repos/plansRepo.js";
```

### Imports mới cho storeCheckout.js
```js
import { purchasePlanForUser, PlanPurchaseError } from "../plans/planPurchase.js";
```

### Env vars mới (optional)
- `TELEGRAM_SUPPORT_USERNAME` — username admin (không có @)
- `FAQ_URL` — URL trang FAQ

### Lưu ý `createApiKey` signature
```js
createApiKey(name, machineId, userId, description?, creditLimit?)
```
`machineId` bắt buộc, không falsy. Dùng `String(telegramId)`.

### Known limitation (QĐ9)
Order commit trước plan activate. Nếu `purchasePlanForUser` fail → cần admin can thiệp.

## Dev Agent Record
### Agent Model Used
Claude Sonnet 4.6

### Completion Notes List
- T1–T4: Implemented handleWallet, handleApi, handleApiCreate, handleApiToggle, handleSupport in router.js. Wired all into dispatcher (switch + callback queries).
- T5: Added plan checkout hook in storeCheckout.js — after order commit, checks product.kind=plan and calls purchasePlanForUser. Attaches planActivation or planActivationError to result.
- T6: handleBuyExecute now shows plan activation confirmation message with plan name + expiry date.
- T7: Created idempotent seed script at src/lib/db/seeds/planProducts.js.
- T8: 12 new unit tests covering all handlers + callback dispatch. Full regression: 1736 pass / 0 fail.

### File List
- src/lib/telegram/router.js (modified — added handlers, wiring, imports)
- src/lib/store/storeCheckout.js (modified — plan activation hook + import)
- src/lib/db/seeds/planProducts.js (new — idempotent plan product seeder)
- tests/unit/telegram-wallet-api-support.test.js (new — 12 tests)
- docs/stories/2-36-telegram-wallet-api-support-plans.md (modified — story tracking)
