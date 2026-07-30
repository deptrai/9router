---
baseline_commit: 803e5c8
epic: I
context:
  - _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-30.md
  - _bmad-output/planning-artifacts/architecture/architecture-9router-2026-07-30/ARCHITECTURE-SPINE.md
  - docs/stories/2-25-telegram-user-linking-product-catalog.md
  - docs/stories/2-26-telegram-checkout-orders.md
  - docs/stories/2-39-vnd-bank-transfer-topup.md
  - src/app/telegram/store/page.js
  - src/lib/telegram/router.js
  - src/lib/telegram/botClient.js
  - src/lib/store/storeCheckout.js
  - src/lib/store/externalCheckout.js
  - src/lib/payment/vndBank.js
  - src/app/api/payments/vnd/route.js
  - src/app/api/store/checkout/route.js
---

# Story 2-25a — Telegram Mini App Product Catalog (Hướng B: In-App Commerce)

Status: ready-for-dev

## Story

**As a** Telegram user,
**I want** mở Mini App, xem sản phẩm, mua và nạp tiền hoàn toàn bên trong Mini App,
**so that** tôi không phải chuyển sang bot chat để xác nhận hay nạp tiền.

## Bối cảnh và quyết định architecture

### Hiện trạng

Story 2.25 đã dựng nền bot (`/start`, `/products`, menu chính) và Story 2-25a đã tạo trang Mini App `src/app/telegram/store/page.js` cơ bản. Tuy nhiên, bản implement đầu dùng **reply-keyboard `web_app` button** để mở Mini App. Theo Telegram spec, Mini App mở từ reply-keyboard **không nhận được `initData`**, do đó:

- Mini App không biết user là ai.
- Không thể gọi API backend để mua/nạp.
- Buộc phải dùng `Telegram.WebApp.sendData` gửi về bot, rồi bot gửi tin nhắn xác nhận thêm một lần nữa.
- Flow trở thành: Mini App → bot xác nhận → bot execute (3 bước, chuyển surface).

### Quyết định Hướng B

Chuyển entry point sang **MenuButton hoặc `inline_keyboard web_app` button** để Mini App nhận `initData` + `query_id`. Từ đó:

- Gọi `POST /api/telegram/miniapp-buy` để mua trực tiếp.
- Gọi `POST /api/telegram/miniapp-topup` để tạo payment và nạp tiền.
- Hiển thị balance, modal xác nhận, kết quả order trong app.

Path cũ `sendData` + `handleBuyConfirm` chỉ giữ làm fallback.

### Hiện trạng code (verified)

- `src/lib/telegram/router.js`: `buildPersistentMenu` dùng reply-keyboard `web_app` button; `handleProducts` gửi `PERSISTENT_MENU`; `handleBuyConfirm`/`handleBuyExecute` dùng callback `buy:`/`buyc:`.
- `src/lib/telegram/botClient.js`: có `sendMessage`, `answerCallbackQuery`, `setWebhook`. Thiếu `setChatMenuButton` và `answerWebAppQuery`.
- `src/app/telegram/store/page.js`: đã load SDK, lấy `initData` từ URL hash/search, gọi `/api/telegram/validate-init-data` và `/api/telegram/user-info`, hiển thị balance. Nút "Mua ngay" hiện gọi `sendData`.
- `src/app/api/telegram/validate-init-data/route.js` và `user-info/route.js`: duplicate code HMAC validate.
- `src/lib/store/storeCheckout.js` và `src/lib/store/externalCheckout.js`: business logic checkout đã sẵn sàng, nhận `userId`, `productId`, `idempotencyKey`.
- `src/lib/payment/vndBank.js`: `createVndPayment({ userId, credits })` đã có.
- `src/app/api/payments/vnd/route.js` và `src/app/api/payments/create/route.js`: cần cookie dashboard session; Mini App dùng `initData` thay thế.
- `src/app/api/store/checkout/route.js`: mẫu JSON response cho `storeCheckout`/`externalCheckout`.

## Scope

### Trong scope

1. Chuyển entry point Mini App sang `MenuButton` / `inline_keyboard web_app`.
2. Tách helper `validateInitData` dùng chung.
3. Tạo `POST /api/telegram/miniapp-buy`.
4. Tạo `POST /api/telegram/miniapp-topup`.
5. Cập nhật `src/app/telegram/store/page.js`: modal mua, top-up CTA, gọi API.
6. Tạo `src/app/telegram/store/topup/page.js`.
7. Cập nhật `src/lib/telegram/router.js` và `botClient.js`.
8. Cập nhật tests Playwright + unit.

### Ngoài scope

- Thay đổi logic `storeCheckout` / `externalCheckout` (chỉ gọi lại).
- Thay đổi schema `products`, `orders`, `payments`.
- Thay đổi `/v1/*` OpenAI-compatible surface.
- Order history UI trong Mini App (dùng `/orders` bot command).

## Acceptance Criteria

### AC1 — Entry point cung cấp initData

**Given** user gõ `/start` hoặc `/products` trong private chat
**When** bot xử lý
**Then**
- `handleStart` gọi `setChatMenuButton` với text `🛍 Shop` và URL Mini App.
- `handleProducts` gửi một tin nhắn kèm inline `web_app` button "Mở cửa hàng" làm fallback.
- Reply keyboard `PERSISTENT_MENU` không còn `web_app` button; nút `🛍 Sản phẩm` map thành `/products`.

### AC2 — Mini App xác thực initData và hiển thị balance

**Given** user mở Mini App từ MenuButton hoặc inline `web_app`
**When** `Telegram.WebApp.initData` có sẵn
**Then**
- `page.js` gửi `initData` tới `POST /api/telegram/user-info`.
- API trả `user` + `balances`.
- Header hiển thị tổng credits và nút `+ Nạp`.
- Catalog hiển thị sản phẩm active.

### AC3 — Mua sản phẩm trong Mini App (one-tap)

**Given** user đang xem catalog, sản phẩm active và còn hàng, số dư đủ
**When** user bấm "Mua ngay" → "Xác nhận mua" trong modal
**Then**
- Client gọi `POST /api/telegram/miniapp-buy` với `initData`, `productId`, `quantity=1`, `requestId`.
- Server validate `initData`, find/create user, gọi `storeCheckout`.
- API trả JSON `{ success, order, ... }`.
- Mini App hiển thị kết quả (mã đơn, trạng thái) và gọi `Telegram.WebApp.close()`.

### AC4 — Thiếu credits

**Given** user bấm "Mua ngay" nhưng số dư không đủ
**When** modal mua hiện
**Then** modal hiển thị "Số dư không đủ" + nút "Nạp credits" chuyển đến màn hình top-up.

### AC5 — Nạp tiền trong Mini App (VND)

**Given** user ở màn hình top-up, chọn VND, nhập số credits
**When** bấm "Tạo QR"
**Then**
- Client gọi `POST /api/telegram/miniapp-topup` với `initData`, `method: "vnd"`, `credits`.
- Server validate `initData`, find/create user, gọi `createVndPayment({ userId, credits })`.
- API trả `{ paymentId, qrUrl, bankInfo, memo, amountVnd, expiresAt }`.
- Client hiển thị QR và bắt đầu poll trạng thái.
- Khi payment `settled`, balance tự động cập nhật qua `POST /api/telegram/user-info`.

### AC6 — Nạp tiền trong Mini App (Crypto)

**Given** user chọn Crypto, chọn coin/network, nhập số USD
**When** bấm "Tạo invoice"
**Then**
- Server tạo payment record và gọi crypto provider `createInvoice`.
- API trả `{ paymentId, payAddress, paymentUrl, network, coin, amountExpected, expiresAt }`.
- Client hiển thị địa chỉ / QR và poll.

### AC7 — Fallback cũ

**Given** user mở Mini App từ reply-keyboard `web_app` cũ (không có `initData`)
**When** bấm "Mua ngay"
**Then** vẫn gọi `sendData` và bot xử lý `web_app_data` như cũ.

### AC8 — Security

- `initData` HMAC validate với `TELEGRAM_BOT_TOKEN`.
- `auth_date` không quá 24h.
- `idempotencyKey` unique tránh double-purchase.
- API `miniapp-buy` và `miniapp-topup` không leak thông tin user/sản phẩm nhạy cảm.

### AC9 — Tests

- Unit test `validateInitData` helper (accept/reject/expired).
- Unit test `miniapp-buy` happy path + INSUFFICIENT_CREDITS + idempotency replay.
- Unit test `miniapp-topup` VND creation.
- Playwright: mở Mini App từ inline `web_app` button, mua, nạp VND.

## Decision Points

### D1 — Entry point

- (A) `MenuButton` cho toàn bộ chat — 1 tap, nhưng user phải biết icon menu.
- (B) `inline_keyboard web_app` button trong tin nhắn — 2 tap (bấm reply text → bấm inline), nhưng rõ ràng.

**Đề xuất (A) kết hợp (B)**: set `MenuButton` làm mặc định, `handleProducts` vẫn gửi inline `web_app` button làm fallback.

### D2 — Xác thực user

- (A) Dùng `initData` raw query string, validate server-side.
- (B) Tạo JWT từ `initData` rồi gửi cookie.

**Đề xuất (A)** — `initData` đã là bằng chứng xác thực từ Telegram, không cần thêm layer cookie.

### D3 — Idempotency

- (A) Dùng `query_id` trong `initData` làm key.
- (B) Dùng `query_id` + client `requestId`.

**Đề xuất (B)** — `query_id` là per session; `requestId` đảm bảo user có thể mua nhiều sản phẩm khác nhau và tránh double-charge cùng sản phẩm.

### D4 — Top-up scope

- (A) Chỉ VND trong app; Crypto redirect dashboard.
- (B) Cả VND và Crypto trong app.

**Đề xuất (B)** — đáp ứng yêu cầu "nạp tiền trên mini app", nhưng crypto chỉ cần tạo invoice/address, không cần UI phức tạp.

## Tasks / Subtasks

### Part A — Shared auth helper

- [ ] **A1**: Tạo `src/lib/auth/telegramWebApp.js` export `validateInitData(initData)` trả `{ ok, user, queryId, authDate }` hoặc `{ error }`.
- [ ] **A2**: Refactor `src/app/api/telegram/validate-init-data/route.js` dùng helper.
- [ ] **A3**: Refactor `src/app/api/telegram/user-info/route.js` dùng helper.

### Part B — Bot client + entry point

- [ ] **B1**: Thêm `setChatMenuButton(chatId, { text, url })` vào `src/lib/telegram/botClient.js`.
- [ ] **B2**: Thêm `answerWebAppQuery(webAppQueryId, result)` vào `src/lib/telegram/botClient.js` (optional).
- [ ] **B3**: Cập nhật `buildPersistentMenu` trong `src/lib/telegram/router.js`: bỏ `web_app` khỏi reply keyboard; `🛍 Sản phẩm` map thành `/products`.
- [ ] **B4**: Cập nhật `handleStart`: sau khi tạo/link user, gọi `setChatMenuButton`.
- [ ] **B5**: Cập nhật `handleProducts`: gửi tin nhắn kèm inline `web_app` button.
- [ ] **B6**: Giữ `handleUpdate.web_app_data` làm fallback; nếu `data.confirmed === true` thì gọi `handleBuyExecute` trực tiếp.

### Part C — Mini App API

- [ ] **C1**: Tạo `src/app/api/telegram/miniapp-buy/route.js`:
  - Validate `initData`.
  - Find/create user theo pattern `/start`.
  - `idempotencyKey = "tgmini:" + telegramId + ":" + productId + ":" + (queryId || "none") + ":" + requestId`.
  - Chọn `storeCheckout` hoặc `externalCheckout` theo `product.source`.
  - Trả JSON giống `POST /api/store/checkout`.
- [ ] **C2**: Tạo `src/app/api/telegram/miniapp-topup/route.js`:
  - Validate `initData`, get user.
  - `method === "vnd"` → `createVndPayment({ userId, credits })`.
  - `method === "crypto"` → tạo payment record + gọi provider `createInvoice`.
  - Trả payment info.
- [ ] **C3**: Tạo `src/app/api/payments/status/route.js` (nếu chưa có) để Mini App poll payment status.

### Part D — Mini App UI

- [ ] **D1**: Cập nhật `src/app/telegram/store/page.js`:
  - Header hiển thị balance + nút `+ Nạp`.
  - "Mua ngay" mở modal xác nhận.
  - Modal hiển thị tên, giá, balance, nút "Xác nhận mua" / "Hủy" / "Nạp credits".
  - Gọi `POST /api/telegram/miniapp-buy` và xử lý response.
- [ ] **D2**: Tạo `src/app/telegram/store/topup/page.js`:
  - Chọn method VND / Crypto.
  - Input credits hoặc USD.
  - Gọi `POST /api/telegram/miniapp-topup`.
  - Hiển thị QR / address.
  - Poll payment status và refresh balance.

### Part E — Tests

- [ ] **E1**: Unit test `src/lib/auth/telegramWebApp.js`.
- [ ] **E2**: Unit test `src/app/api/telegram/miniapp-buy`.
- [ ] **E3**: Unit test `src/app/api/telegram/miniapp-topup`.
- [ ] **E4**: Cập nhật Playwright `playwright/e2e/telegram-store-webapp.spec.ts`.

## Dev Notes

### `validateInitData` helper

Signature:

```js
export function validateInitData(initData) {
  // return { ok: true, user, queryId, authDate } or { ok: false, error }
}
```

- Parse `initData` bằng `URLSearchParams`.
- Lấy `hash`, `auth_date`, `user`, `query_id`.
- Tạo `dataCheckString` từ các pair sorted (bỏ `hash`).
- `HMAC_SHA256(HMAC_SHA256(botToken, "WebAppData"), dataCheckString) === hash`.
- `auth_date` < 24h.

### `miniapp-buy` response shape

Giống `POST /api/store/checkout`:

```json
{
  "success": true,
  "order": { ... },
  "alreadyProcessed": false,
  "credentials": [],
  "entitlementId": null,
  "planActivation": null,
  "message": "Mua thành công!"
}
```

Lỗi:

```json
{ "error": "Số dư không đủ." }
```

### `miniapp-topup` VND response shape

```json
{
  "success": true,
  "paymentId": "...",
  "qrUrl": "...",
  "bankInfo": { ... },
  "memo": "...",
  "credits": 100,
  "amountVnd": 100000,
  "expiresAt": "..."
}
```

### `miniapp-topup` Crypto response shape

```json
{
  "success": true,
  "paymentId": "...",
  "payAddress": "...",
  "paymentUrl": "...",
  "network": "tron",
  "coin": "USDT",
  "amountExpected": 10,
  "expiresAt": "..."
}
```

### User auto-create

```js
const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username || `tg_${telegramId}`;
const placeholderEmail = `telegram_${telegramId}@placeholder.local`;
const newUser = await createUser(placeholderEmail, null, displayName);
await updateUser(newUser.id, { telegramId });
```

### `setChatMenuButton` payload

```js
{
  chat_id: chatId,
  menu_button: {
    type: "web_app",
    text: "🛍 Shop",
    web_app: { url: getStoreUrl() }
  }
}
```

### Fallback `web_app_data`

Nếu `data.confirmed === true`:

```js
await handleBuyExecute(chatId, from, productId, "webapp:" + Date.now());
```

Nếu `data.confirmed !== true`:

```js
await handleBuyConfirm(chatId, productId);
```

## Regression / scope guard

- Không thay đổi `storeCheckout`/`externalCheckout` contracts.
- `handleBuyConfirm`/`handleBuyExecute` giữ nguyên để `/products` text fallback vẫn hoạt động.
- OpenAI-compatible `/v1/*` không bị ảnh hưởng.
- Không thêm dependency mới ngoài Next.js + React + Telegram JS SDK đã có.

## References

- `docs/stories/2-25-telegram-user-linking-product-catalog.md`
- `docs/stories/2-26-telegram-checkout-orders.md`
- `docs/stories/2-39-vnd-bank-transfer-topup.md`
- `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-30.md`
- `_bmad-output/planning-artifacts/architecture/architecture-9router-2026-07-30/ARCHITECTURE-SPINE.md`
