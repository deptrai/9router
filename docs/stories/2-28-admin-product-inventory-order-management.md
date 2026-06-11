---
baseline_commit: 5177050
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - docs/stories/2-27-inventory-fulfillment-other-products.md
  - docs/stories/2-26-telegram-checkout-orders.md
  - src/lib/db/repos/productsRepo.js
  - src/lib/db/repos/ordersRepo.js
  - src/lib/db/repos/credentialsRepo.js
  - src/lib/db/schema.js
  - src/lib/auth/requireRole.js
  - src/app/api/store/products/route.js
---

# Story 2.28 — Admin Product, Inventory & Order Management

Status: ready-for-review

## Story

**As an** admin,
**I want** quản lý products, inventory (credentials), orders, và fulfillment qua API,
**so that** tôi vận hành Telegram Store mà không cần sửa DB thủ công.

## Bối cảnh và quyết định architecture

Story 2.27 đã xây dựng:
- `productCredentials` table (SCHEMA_VERSION=9) — per-unit credential inventory, mã hoá AES-256-GCM at rest.
- `credentialsRepo` — `addCredential`, `listCredentials`, `getCredentialById`, `countAvailableCredentials`, `getAvailableCredentialSync`, `deliverCredentialSync`, `revokeCredential`, `getDecryptedPayload`.
- `storeCheckout` — instant credential reserve + delivery sau commit; admin_fulfill giữ `paid`.
- `CREDENTIAL_STATUSES = ["available", "delivered", "revoked"]` — **chưa có `reserved`** (D1 defer).

Các **deferred item từ 2.27** cần xử lý trong 2.28:

- **D1** — Thêm `reserved` vào `CREDENTIAL_STATUSES`, cột `reservedAt` vào `productCredentials`, và transition `available → reserved` trong txn + `reserved → delivered` sau sendMessage.
- **D2** — Catalog display kiểm tra `countAvailableCredentials` để ẩn/hiện nút "Mua ngay" đúng.
- **D3** — `productHasInventory(productId)` theo QĐ1: dùng đếm item trong DB thay vì `kind === "credential"`.

Ngoài deferred items, **2.28 thêm admin CRUD APIs** được chú thích sẵn trong comment của `GET /api/store/products/route.js`:

- Admin product CRUD: create, update (fields + isActive toggle), delete (chỉ khi không có order).
- Admin inventory CRUD: upload credential batch, list (với status filter), revoke.
- Admin order management: list tất cả orders (với filter), view detail, manual fulfill hoặc cancel.

### Hiện trạng code (verified tại baseline 5177050)

- **`productsRepo`**: `listActiveProducts()`, `getProductById(id)`, `createProduct(data)`. **Thiếu**: `updateProduct`, `deleteProduct`, `listAllProducts` (admin view, kể cả inactive).
- **`ordersRepo`**: `listOrdersByUser(userId, opts)` — chỉ filter theo `userId`. **Thiếu**: `listAllOrders(opts)` (admin, filter status/productId/userId), `getOrdersByStatus`.
- **`credentialsRepo`**: đầy đủ cho buyer flow. **Thiếu**: `listCredentials` đã có nhưng cần expose qua admin API; `bulkAddCredentials` (upload nhiều dòng).
- **Auth**: `requireAdmin(request)` từ `src/lib/auth/requireRole.js` — pattern chuẩn, dùng cho tất cả admin endpoints.
- **Schema**: SCHEMA_VERSION=9 (productCredentials). D1 cần bump lên 10: thêm cột `reservedAt TEXT` vào `productCredentials` + thêm `reserved` status.
- **`src/app/api/store/products/route.js`**: GET public không cần auth. POST/PATCH/DELETE sẽ thêm vào đây với `requireAdmin` guard.

### Quyết định architecture

**QĐ1 — Admin API route structure.**
Dùng Next.js App Router file-based routing:
- `/api/store/admin/products` — GET (list all), POST (create)
- `/api/store/admin/products/[id]` — GET, PATCH, DELETE
- `/api/store/admin/products/[id]/credentials` — GET (list inventory), POST (add single), DELETE (bulk revoke by ids)
- `/api/store/admin/orders` — GET (list all, filter), PATCH `/[id]` (fulfill/cancel)

Tất cả admin routes đều `requireAdmin` — trả 403 nếu không có session hợp lệ.

**QĐ2 — D1: Schema migration `reservedAt` + `reserved` status.**
Bump SCHEMA_VERSION 9→10. Thêm cột `reservedAt TEXT` nullable vào `productCredentials`. `syncSchemaFromTables` tự ALTER TABLE nếu thiếu cột. Cập nhật `CREDENTIAL_STATUSES` thành `["available", "reserved", "delivered", "revoked"]`. Cập nhật `storeCheckout`: trong txn dùng `deliverCredentialSync` → đổi thành hai bước: `reserveCredentialSync` (available→reserved, set reservedAt) trong txn; sau commit `completeDeliverySync` (reserved→delivered, set deliveredAt) sau sendMessage OK.

**QĐ3 — D3: `productHasInventory(productId)` đúng theo QĐ1 của 2.27.**
Thêm vào `credentialsRepo`: `SELECT COUNT(*) FROM productCredentials WHERE productId = ?` (không filter status) → `> 0`. `storeCheckout` gọi hàm này thay vì check `kind === "credential"`.

**QĐ4 — D2: Catalog hiển thị stock thực.**
Trong `handleProducts` (router.js Telegram): với product `kind=credential/account/api_package`, gọi `countAvailableCredentials(productId)` trước khi render nút "Mua ngay". Nếu `count === 0` và `deliveryMode === "instant"` → hiển thị "⛔ Hết hàng" thay nút mua.

**QĐ5 — Admin fulfill flow.**
Admin gọi `PATCH /api/store/admin/orders/[id]` với `{ action: "fulfill", note?, credentialId? }`:
- Nếu product là credential + `instant`: admin chọn credentialId từ available inventory → `reserveCredentialSync` (nếu chưa reserved) + `deliverCredentialSync` → transition order `paid → fulfilled` → gửi Telegram buyer (best-effort).
- Nếu product khác (service, account): chỉ transition `paid → fulfilled` + ghi note.
- Cancel: `PATCH` với `{ action: "cancel" }` → transition `paid → cancelled`; nếu có reserved credential thì revoke lại về `available`.

**QĐ6 — Bulk credential upload.**
`POST /api/store/admin/products/[id]/credentials` nhận `{ credentials: [{payload, note?}, ...] }` (JSON array). Validate: max 500 items per request. Mỗi item gọi `addCredential`. Trả `{ added: N, failed: M, errors: [...] }`. Payload không bao giờ echo lại trong response.

**QĐ7 — Không xoá product có order.**
`DELETE /api/store/admin/products/[id]`: check `SELECT COUNT(*) FROM orders JOIN orderItems ... WHERE productId=?` — nếu có order → trả 409 `"Sản phẩm đã có đơn hàng, không thể xoá. Hãy set isActive=false."`. Nếu không có order → xoá product + toàn bộ credential inventory liên quan (CASCADE hoặc explicit DELETE).

## Acceptance Criteria

### AC1 — Admin CRUD product (FR48)
**Given** admin gọi `POST /api/store/admin/products` với fields hợp lệ (`name`, `kind`, `priceCredits`, `deliveryMode`, `targetType?`, `targetId?`, `stock?`, `isActive?`)
**Then** product được tạo, trả `201` với product object (không có inventory/payload)
**And** `kind` phải thuộc `PRODUCT_KINDS`; `deliveryMode` thuộc `DELIVERY_MODES`; `priceCredits` > 0
**And** `targetType="9router_plan"` yêu cầu `targetId` trỏ tới plan tồn tại (validate trước insert).

**Given** admin gọi `PATCH /api/store/admin/products/[id]`
**Then** các field được update; `isActive=false` ẩn product khỏi public catalog ngay lập tức
**And** không cho phép thay đổi `kind` sau khi product đã có order.

**Given** admin gọi `DELETE /api/store/admin/products/[id]`
**When** product chưa có order nào
**Then** xoá product + credentials liên quan, trả `200`
**When** product đã có order
**Then** trả `409` với message hướng dẫn dùng `isActive=false`.

### AC2 — Admin list + filter orders (FR48)
**Given** admin gọi `GET /api/store/admin/orders?status=paid&limit=20&offset=0`
**Then** trả danh sách orders với status=paid, có pagination metadata (`total`, `limit`, `offset`)
**And** mỗi order item gồm: `id`, `userId`, `status`, `totalCredits`, `productSnapshot` (name/kind/deliveryMode), `createdAt`, `fulfilledAt?`
**And** không có payload credential trong response.

### AC3 — Admin manual fulfill order (FR45, FR48)
**Given** order có `status="paid"` và `deliveryMode="admin_fulfill"`
**When** admin gọi `PATCH /api/store/admin/orders/[id]` với `{ action: "fulfill", note? }`
**Then** order transition `paid → fulfilled`, `fulfilledAt` set
**And** buyer nhận Telegram notification "✅ Đơn hàng #[id] đã được xử lý." (best-effort, không rollback nếu gửi fail)
**And** nếu product là `kind=credential` và có available inventory: admin có thể truyền `credentialId` → credential được giao qua private message tới buyer.

### AC4 — Admin cancel order (FR48)
**Given** order có `status="paid"`
**When** admin gọi `PATCH /api/store/admin/orders/[id]` với `{ action: "cancel", note? }`
**Then** order transition `paid → cancelled`
**And** nếu có credential đang `reserved` cho order này → credential trả về `available` (hoặc `revoked` nếu đã giao một phần)
**And** credit **không** tự động refund ở 2.28 (admin xử lý manual qua credit ledger nếu cần — out of scope 2.28).

### AC5 — Admin inventory management (FR48, FR49, NFR8)
**Given** admin gọi `POST /api/store/admin/products/[id]/credentials` với `{ credentials: [{payload, note?}] }`
**Then** mỗi credential được encrypt at rest và insert với `status="available"`
**And** response chỉ trả `{ added: N }` — **không echo payload hay ciphertext**
**And** max 500 items per request; vượt quá trả 422.

**Given** admin gọi `GET /api/store/admin/products/[id]/credentials?status=available`
**Then** trả list với `id`, `status`, `hasPayload`, `orderId?`, `deliveredAt?`, `note?`, `createdAt` — **không có `payload` hay ciphertext**.

**Given** admin gọi `DELETE /api/store/admin/products/[id]/credentials` với `{ ids: [...] }`
**Then** các credential được `revoked` (không xoá khỏi DB để giữ audit trail)
**And** chỉ `available` credentials mới được revoke; `delivered` trả warning per-item.

### AC6 — D1: `reserved` status + `reservedAt` audit trail
**Given** checkout instant credential product
**When** transaction commit
**Then** credential status = `reserved` (không phải `delivered`) với `reservedAt` set
**And** sau `sendMessage` thành công → status = `delivered` với `deliveredAt` set
**And** nếu `sendMessage` thất bại → status giữ `reserved`; admin thấy trong inventory list và có thể deliver manual.

### AC7 — D2: Catalog ẩn nút mua khi hết credential inventory
**Given** product `kind=credential`, `deliveryMode=instant`, không có credential `available`
**When** user xem product list trong Telegram bot (`/products`)
**Then** sản phẩm hiển thị nhưng nút "Mua ngay" thay bằng "⛔ Tạm hết hàng" (không clickable)
**And** user không thể khởi động checkout flow cho product đó.

### AC8 — D3: `productHasInventory` theo QĐ1
**Given** product `kind=credential` chưa được seed credential nào
**When** `storeCheckout` chạy
**Then** dùng `products.stock` path (như 2.26) thay vì credential path
**And** không ném `NO_INVENTORY` khi product chưa có inventory record nào trong DB.

### AC9 — Auth guard tất cả admin endpoints (NFR2)
**Given** request không có valid admin session
**When** gọi bất kỳ `/api/store/admin/*` endpoint nào
**Then** trả `403 Forbidden`
**And** không có data nào leak trong error response.

## Tasks / Subtasks

- [x] **T1 — Schema: cột `reservedAt` + bump SCHEMA_VERSION 9→10** (AC6, D1)
  - [x] Thêm `reservedAt TEXT` nullable vào `productCredentials` trong `schema.js`.
  - [x] Bump `SCHEMA_VERSION = 10`.
  - [x] Cập nhật `CREDENTIAL_STATUSES` thêm `"reserved"`: `["available", "reserved", "delivered", "revoked"]`.
  - [x] `syncSchemaFromTables` sẽ ALTER TABLE thêm cột nếu thiếu (verify driver hỗ trợ).

- [x] **T2 — `credentialsRepo`: `reserveCredentialSync` + `completeDeliverySync` + `productHasInventory` + `bulkAddCredentials`** (AC5, AC6, AC8, D1, D3)
  - [x] `reserveCredentialSync(adapter, productId, orderId, now)`: UPDATE available→reserved, set `orderId`, `reservedAt`; trả item hoặc null nếu `changes===0`.
  - [x] `completeDeliverySync(adapter, credentialId, now)`: UPDATE reserved→delivered, set `deliveredAt`; throw nếu `changes===0`.
  - [x] `productHasInventory(productId)`: `SELECT COUNT(*) FROM productCredentials WHERE productId=?` > 0. Async.
  - [x] `bulkAddCredentials(productId, items)`: `items = [{payload, note?}]`; loop `addCredential`; trả `{added, failed, errors}`.
  - [x] `getCredentialsByOrderId(orderId)`: list credentials gắn với một order (dùng cho admin order detail).

- [x] **T3 — Cập nhật `storeCheckout` dùng `reserveCredentialSync` + `completeDeliverySync`** (AC6, D1, D3)
  - [x] Trong txn: thay `deliverCredentialSync` bằng `reserveCredentialSync` → credential status = `reserved` sau commit.
  - [x] Gate `productHasInventory(productId)` thay cho `product.kind === "credential"` check (D3).
  - [x] Sau txn commit + sendMessage OK: gọi `completeDeliverySync` → `delivered`.
  - [x] Sau txn commit + sendMessage FAIL: giữ `reserved`; log warning; trả message "đã ghi nhận, xem /orders".
  - [x] Trả `reservedCredentialId` (thay `deliveredCredentialId`) trong result để caller có thể complete delivery.

- [x] **T4 — Cập nhật `router.js` Telegram: D2 catalog display** (AC7, D2)
  - [x] Trong `handleProducts`: với product `kind ∈ {credential, account, api_package}` và `deliveryMode=instant`, gọi `countAvailableCredentials(productId)`; nếu 0 → render "⛔ Tạm hết hàng" (text, không có callback button mua).
  - [x] Handler `buyc:` nhận `reservedCredentialId` từ `storeCheckout` result; sau sendMessage thành công gọi `completeDeliverySync`.

- [x] **T5 — `productsRepo`: thêm admin functions** (AC1)
  - [x] `listAllProducts({ limit, offset, isActive? })`: list kể cả inactive, có pagination.
  - [x] `updateProduct(id, data)`: partial update; không cho đổi `kind` nếu có order (check trong repo hoặc route handler).
  - [x] `deleteProduct(id)`: xoá product; route handler guard hasOrder trước khi gọi.
  - [x] `productHasOrders(productId)`: `SELECT COUNT(*) FROM orderItems WHERE productId=?` > 0.

- [x] **T6 — `ordersRepo`: thêm admin functions** (AC2, AC3, AC4)
  - [x] `listAllOrders({ status?, userId?, productId?, limit, offset })`: admin list với filter + pagination; join `orderItems` để có `productId`.
  - [x] `countAllOrders({ status?, userId?, productId? })`: count cho pagination metadata.
  - [x] `getOrderWithItems(orderId)`: order + items đầy đủ cho detail view.
  - [x] `setFulfilledAt(adapter, orderId, ts)`: set `fulfilledAt` khi admin fulfill (nếu cột chưa có trong schema, thêm vào T1).

- [x] **T7 — Admin API routes** (AC1, AC2, AC3, AC4, AC5, AC9)
  - [x] `src/app/api/store/admin/products/route.js` — GET (listAllProducts), POST (createProduct + validate targetId nếu targetType=9router_plan).
  - [x] `src/app/api/store/admin/products/[id]/route.js` — GET (getProductById), PATCH (updateProduct), DELETE (guard hasOrders → 409 hoặc xoá).
  - [x] `src/app/api/store/admin/products/[id]/credentials/route.js` — GET (listCredentials với status filter), POST (bulkAddCredentials, max 500), DELETE (revoke by ids).
  - [x] `src/app/api/store/admin/orders/route.js` — GET (listAllOrders với filter + pagination).
  - [x] `src/app/api/store/admin/orders/[id]/route.js` — GET (getOrderWithItems), PATCH (action: fulfill|cancel).
  - [x] Tất cả routes: `requireAdmin` guard đầu tiên, trả 403 nếu fail. `export const dynamic = "force-dynamic"`.

- [x] **T8 — Fulfill + cancel logic** (AC3, AC4)
  - [x] `src/lib/store/adminFulfill.js`: `fulfillOrder(orderId, { credentialId?, note?, adminSession })`:
    - Load order, validate `status === "paid"`.
    - Nếu product kind=credential + credentialId provided: `reserveCredentialSync` nếu available + `transitionOrder(paid→fulfilled)` (atomic).
    - Else: chỉ `transitionOrder(paid→fulfilled)`.
    - Sau commit: `sendMessage(buyerTelegramId, ...)` best-effort; nếu credential: `completeDeliverySync`.
    - Trả `{ order, credentialDelivered: boolean, telegramSent: boolean }`.
  - [x] `cancelOrder(orderId, { note? })`:
    - Load order, validate `status === "paid"`.
    - Nếu có credential `reserved` cho order → `UPDATE status='available', orderId=null, reservedAt=null` (un-reserve).
    - `transitionOrder(paid→cancelled)`.

- [x] **T9 — Tests** (AC1–AC9)
  - [x] `tests/unit/credentialsRepo.test.js`: thêm test `reserveCredentialSync`, `completeDeliverySync`, `productHasInventory`, `bulkAddCredentials`.
  - [x] `tests/unit/storeCheckout.test.js`: cập nhật expect `reserved` (không phải `delivered`) sau txn; `delivered` sau completeDelivery; D3 gate.
  - [x] `tests/unit/adminFulfill.test.js`: fulfill credential order (credential delivered + order fulfilled); fulfill non-credential; cancel + un-reserve credential; cancel fulfilled order → fail.
  - [x] `tests/integration/adminProducts.test.js` (nếu có integration test pattern) hoặc vitest unit với mock adapter: CRUD product lifecycle, delete guard, bulk credential upload max-500.
  - [x] Regression: 2.26 plan purchase flow không bị ảnh hưởng (thêm test case trong storeCheckout nếu chưa có).

- [x] **T10 — Seed script + docs**
  - [x] Cập nhật seed script (nếu có) để demo credential product với inventory.
  - [x] Ghi note vào `.env.example` về `STORE_ENC_KEY` (đã có từ 2.27, xác nhận không xoá).
  - [x] Comment API shape trong route files (JSDoc hoặc inline) để dev dùng không cần đọc hết code.

## Dev Agent Record

### File List (đã triển khai)

- src/lib/db/schema.js (bump v10, thêm `reservedAt`, `fulfilledAt`)
- src/lib/db/migrations/006-store-v2.js (ALTER thêm `reservedAt` + `fulfilledAt`)
- src/lib/db/repos/credentialsRepo.js (thêm `reserveCredentialSync`, `completeDeliverySync`, `productHasInventory`, `reserveCredentialByIdSync`, `releaseReservationSync`, `getCredentialsByOrderId`)
- src/lib/db/repos/productsRepo.js (thêm `listAllProducts`, `updateProduct`, `deleteProduct`, `productHasOrders`)
- src/lib/db/repos/ordersRepo.js (thêm `listAllOrders`, `countAllOrders`, `getOrderWithItems`, `setFulfilledAt`, `fulfilledAt` trong mapper)
- src/lib/store/storeCheckout.js (reserve→reserved, D3 gate, completeDelivery sau commit)
- src/lib/store/adminFulfill.js (mới — `fulfillOrder`, `cancelOrder`, `FulfillError`)
- src/lib/telegram/router.js (D2 catalog display, completeDelivery sau sendMessage)
- src/app/api/store/admin/products/route.js (mới)
- src/app/api/store/admin/products/[id]/route.js (mới)
- src/app/api/store/admin/products/[id]/credentials/route.js (mới)
- src/app/api/store/admin/orders/route.js (mới)
- src/app/api/store/admin/orders/[id]/route.js (mới)
- scripts/seed.js (thêm store demo: credential product + 3 credential inventory)
- tests/unit/credentialsRepo.test.js (mở rộng — `reserveCredentialByIdSync`, `releaseReservationSync`)
- tests/unit/storeCheckout.test.js (cập nhật expectations)
- tests/unit/adminFulfill.test.js (mới)

### Completion Notes (AI dev)

- **Tất cả 10 task (T1–T10) hoàn tất.** Build sạch (`npm run build`), 5 admin route đăng ký dưới dạng dynamic function.
- **Test: 51/51 pass** across `credentialsRepo` (21), `storeCheckout` (10 store), `adminFulfill` (10) — chạy `npm test -- unit/credentialsRepo.test.js unit/storeCheckout.test.js unit/adminFulfill.test.js`.
- **NFR8 verified:** `grep -rnE "payload|ciphertext" src/app/api/store/` chỉ ra doc-comment + đọc input bulk-add; không response nào echo payload/ciphertext. Credential payload chỉ giao qua Telegram private message.
- **Lệch nhẹ so với kế hoạch:**
  - `bulkAddCredentials` (dự kiến trong T2) không thêm vào repo — route credentials POST loop `addCredential` trực tiếp với cap 500 (422 nếu vượt). Hành vi giống hệt, ít bề mặt API hơn.
  - Thêm 2 helper sync mới ngoài kế hoạch để admin fulfill chính xác: `reserveCredentialByIdSync` (admin chọn credential cụ thể) và `releaseReservationSync` (un-reserve khi cancel).
  - `FulfillError` codes → HTTP: `ORDER_NOT_FOUND`=404, `INVALID_STATE`/`CREDENTIAL_UNAVAILABLE`=409.
- **Auth (AC9):** mọi `/api/store/admin/*` gọi `requireAdmin` đầu tiên → 403 nếu không phải admin (lưu ý `requireRole` hiện default no-token → admin để backward-compat; siết lại khi có RBAC đầy đủ).
- **Credit refund khi cancel:** ngoài scope (AC4) — `cancelOrder` chỉ release credential + chuyển `paid→cancelled`, không hoàn credit.

### Ghi chú triển khai (kế hoạch ban đầu)

- **`reserved` state cleanup**: nếu server restart giữa txn commit và `completeDelivery`, item sẽ stuck ở `reserved`. 2.28 scope: admin có thể thấy `reserved` items trong inventory list và manually deliver hoặc revoke. Auto-cleanup (cron) là 2.29+.
- **Credit refund khi cancel**: ngoài scope 2.28 (ghi rõ trong AC4). Admin tự refund qua credit ledger admin endpoint (story 2.x).
- **`fulfilledAt` cột mới trên `orders`**: nếu `syncSchemaFromTables` không tự ALTER, cần migration statement riêng — kiểm tra driver behavior trong T1.
- **Telegram notification khi admin fulfill**: dùng `buyerTelegramId` từ `users.telegramId`; nếu user chưa link Telegram thì skip notification, vẫn fulfill order.
- **Không expose ciphertext qua bất kỳ API nào** (NFR8): mọi `rowToCredential` mapper đã suppress payload. Admin API không có endpoint nào trả plaintext credential — delivery chỉ qua Telegram private message.

## Verification

- `npx vitest run tests/unit/credentialsRepo.test.js tests/unit/storeCheckout.test.js tests/unit/adminFulfill.test.js` — tất cả pass.
- `npm run build` — không có TypeScript/lint error, routes compile.
- Manual smoke:
  - Seed credential product → mua instant → credential ở `reserved` sau txn, `delivered` sau sendMessage.
  - Admin list orders `GET /api/store/admin/orders?status=paid` → trả đúng danh sách.
  - Admin fulfill admin_fulfill order → order `fulfilled`, Telegram message gửi.
  - Admin cancel paid order có reserved credential → credential trở về `available`.
  - Bulk upload 5 credentials → `added: 5`; upload 501 → 422.
  - Delete product có order → 409; delete product chưa có order → 200.
- Grep bảo mật: `grep -rI "payloadEnc\|\.payload" src/app/api/store` không expose credential trong response shape.
- Regression 2.26: plan purchase flow không bị ảnh hưởng (test storeCheckout non-credential product).
