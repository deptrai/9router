---
baseline_commit: 803e5c8
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - docs/stories/2-25-telegram-user-linking-product-catalog.md
  - docs/stories/2-26-telegram-checkout-orders.md
---

# Story 2-25a — Telegram Mini App Product Catalog

Status: ready-for-dev

## Story

**As a** Telegram user,
**I want** mở Mini App từ bot để xem danh sách sản phẩm,
**so that** tôi có thể duyệt catalog lớn mà không bị spam nhiều tin nhắn trong chat.

## Bối cảnh và quyết định architecture

Story 2.25 đã dựng nền bot `/start` + `/products` + menu chính, trong đó `/products` gửi **mỗi product một tin nhắn riêng**. Khi catalog mở rộng (hàng chục/hàng trăm sản phẩm từ supplier Telegram), cách làm này:

- Spam chat, khó cuộn tìm kiếm.
- Dễ đụng Telegram rate-limit.
- Không hỗ trợ filter/sort, UX kém.

Story 2-25a tối ưu UX bằng cách chuyển danh sách sản phẩm vào **Telegram Mini App** (Webview). Người dùng bấm “🛍 Sản phẩm” hoặc gõ `/products` thì bot gửi **một tin nhắn duy nhất** kèm nút mở Mini App. Mini App hiển thị catalog đầy đủ; khi chọn mua thì gửi `web_app_data` về bot, bot dùng lại flow xác nhận mua từ story 2.26 (`handleBuyConfirm` / `handleBuyExecute`).

### Hiện trạng code (verified)

- **Bot infra đã có**: `src/lib/telegram/botClient.js` (pure fetch), `src/lib/telegram/router.js` (`handleUpdate` dispatch), `POST /api/telegram/webhook`.
- **Product catalog API đã có**: `GET /api/store/products` trả active products.
- **Checkout flow đã có**: `handleBuyConfirm` (callback `buy:<productId>`) và `handleBuyExecute` (`buyc:<productId>`) trong `router.js`.
- **Telegram auth pattern đã có**: `src/lib/auth/telegramAuth.js` dùng HMAC-SHA256 cho login widget; Mini App cần cơ chế tương tự nhưng với `WebAppData` key.
- **Next.js + Tailwind đã có**: phù hợp để xây dựng trang Mini App nhanh.

### Scope 2-25a (CHỈ story này)

Làm:
1. Trang Mini App `src/app/telegram/store/page.js` — client component, load SDK Telegram, xác thực `initData`, hiển thị product list.
2. API `POST /api/telegram/validate-init-data` — validate `Telegram.WebApp.initData` theo Telegram spec, trả `user`.
3. (Optional) API `POST /api/telegram/user-info` — trả user + số dư credits để hiển thị trong Mini App.
4. Cập nhật `src/lib/telegram/router.js`:
   - `PERSISTENT_MENU`: nút “🛍 Sản phẩm” mở Mini App (`web_app` button).
   - `handleProducts`: gửi một tin nhắn duy nhất kèm nút mở Mini App.
   - `handleUpdate`: xử lý `message.web_app_data` (`{ action: "buy", productId }`) → gọi `handleBuyConfirm`.
5. Cập nhật `tests/unit/telegram-store.test.js`.

KHÔNG làm (để story sau hoặc đã có):
- Checkout lõi (2.26) — Mini App chỉ trigger lại flow cũ.
- Wallet/orders/commands khác — menu vẫn giữ các nút text command.

## Acceptance Criteria

**AC1 — Mini App button**
- WHEN user nhắn `/products` HOẶC bấm “🛍 Sản phẩm”
- THEN bot gửi **một tin nhắn duy nhất** kèm `reply_markup` có nút `web_app` mở `https://<BASE_URL>/telegram/store`

**AC2 — Mini App product listing**
- WHEN Mini App load
- AND `Telegram.WebApp.initData` được gửi tới `POST /api/telegram/validate-init-data`
- AND `hash` hợp lệ
- THEN Mini App gọi `GET /api/store/products` và hiển thị danh sách sản phẩm active
- AND mỗi card hiển thị: tên, mô tả ngắn, giá credits, tồn kho, nút “Mua ngay”
- AND product hết hàng/inactive → nút “Mua ngay” bị vô hiệu hóa

**AC3 — Buy from Mini App**
- WHEN user bấm “Mua ngay” trong Mini App
- THEN Mini App gọi `Telegram.WebApp.sendData(JSON.stringify({ action: "buy", productId: p.id }))`
- AND bot nhận `web_app_data` và gọi `handleBuyConfirm(productId)` để hiện xác nhận trong chat

**AC4 — Fallback**
- WHEN client Telegram không hỗ trợ Mini App
- AND user gõ `/products` bằng text
- THEN bot vẫn có thể trả về danh sách sản phẩm dạng text như cũ HOẶC hướng dẫn cập nhật Telegram

**AC5 — Security**
- WHEN Mini App gọi API
- THEN `initData` được xác thực HMAC-SHA256 bằng `TELEGRAM_BOT_TOKEN`
- AND `auth_date` không quá cũ (ví dụ < 24h)
- AND request không hợp lệ → 401, không leak thông tin

**AC6 — Tests**
- WHEN dev hoàn tất: tests cover `handleProducts` gửi `web_app` button, `web_app_data` dispatch tới `handleBuyConfirm`, validate-init-data reject/accept.

## Decision Points (cần chốt)

- **D1 — Cập nhật story 2.25 hay tạo story mới**: Đã chọn **tạo story 2-25a** để giữ 2.25 nguyên vẹn.
- **D2 — Mini App checkout**: (A) Gửi `web_app_data` về bot rồi xác nhận trong chat — đơn giản, reuse 2.26. (B) Checkout hoàn toàn trong Mini App qua API — UX mượt hơn nhưng cần thêm API + xử lý idempotency. **Đề xuất (A)** cho story này.
- **D3 — Product list fetch**: Gọi public `GET /api/store/products` sau khi validate `initData` — không cần auth cookie vì user đã xác thực qua Telegram.

## Tasks / Subtasks

### Part A — API xác thực Mini App
- [ ] **A1**: Tạo `src/app/api/telegram/validate-init-data/route.js` — validate `Telegram.WebApp.initData`, trả `user`.
- [ ] **A2** (Optional): Tạo `src/app/api/telegram/user-info/route.js` — trả `user` + `balances` cho Mini App header.

### Part B — Mini App UI
- [ ] **B1**: Tạo `src/app/telegram/store/page.js` — client component, load SDK, gọi validate, gọi products, render list.
- [ ] **B2**: Styling với Tailwind: header (credits), search/filter (optional), product cards, “Mua ngay” buttons.
- [ ] **B3**: “Mua ngay” gọi `Telegram.WebApp.sendData({ action: "buy", productId })`.

### Part C — Bot router update
- [ ] **C1**: Cập nhật `PERSISTENT_MENU` trong `src/lib/telegram/router.js` — “🛍 Sản phẩm” là `web_app` button.
- [ ] **C2**: Cập nhật `handleProducts` — gửi 1 tin nhắn với `web_app` button thay vì loop nhiều tin nhắn.
- [ ] **C3**: Thêm xử lý `update.message.web_app_data` trong `handleUpdate`, gọi `handleBuyConfirm`.

### Part D — Tests
- [ ] **D1**: Cập nhật `tests/unit/telegram-store.test.js` — test Mini App button + `web_app_data` dispatch.

## Dev Notes

### Reuse patterns

**`src/lib/telegram/botClient.js`**: `sendMessage` đã hỗ trợ `reply_markup`. Truyền vào:
```js
{
  reply_markup: {
    inline_keyboard: [[
      { text: "🛒 Xem danh sách sản phẩm", web_app: { url: `${baseUrl}/telegram/store` } }
    ]]
  }
}
```

**`src/lib/telegram/router.js`**: Handler `handleUpdate` cần thêm nhánh:
```js
if (update.message?.web_app_data) {
  const data = JSON.parse(update.message.web_app_data.data);
  if (data.action === "buy" && data.productId) {
    await handleBuyConfirm(chatId, data.productId);
  }
  return;
}
```

**`initData` validation** (Telegram spec):
- Parse query string, lấy `hash`.
- Sort remaining `key=value` pairs alphabetically, join bằng `\n`.
- `HMAC_SHA256(HMAC_SHA256(bot_token, "WebAppData"), data_check_string)` so sánh với `hash`.

### Setup vận hành

- `BASE_URL` / `NEXT_PUBLIC_BASE_URL` phải trỏ đúng domain (`https://router.chainlens.net`).
- Mini App URL cần HTTPS (đã có qua domain chính).
- `TELEGRAM_BOT_TOKEN` đã set.

### Regression / scope guard

- Không thay đổi `products` table, `orders`, `credit ledger`, hay `storeCheckout`.
- Nút mua `buy:<productId>` trong chat vẫn giữ để các kịch bản fallback hoạt động.
- `handleWallet`, `handleOrders`, `handleApi`, `handleSupport` không đổi.

## References

- [Story 2.25] `docs/stories/2-25-telegram-user-linking-product-catalog.md`
- [Story 2.26] `docs/stories/2-26-telegram-checkout-orders.md`
- [Proposal] `_bmad-output/planning-artifacts/sprint-change-proposal-telegram-mini-app-2026-07-29.md`
