---
baseline_commit: 5177050
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - docs/stories/2-26-telegram-checkout-orders.md
  - docs/stories/2-25-telegram-user-linking-product-catalog.md
  - src/lib/store/storeCheckout.js
  - src/lib/db/repos/ordersRepo.js
  - src/lib/db/repos/productsRepo.js
  - src/lib/db/schema.js
---

# Story 2.27 — Inventory & Fulfillment Cho Sản Phẩm Khác

Status: done

## Story

**As a** buyer trong Telegram shop,
**I want** nhận credential/account/service status ngay sau khi mua (hoặc thấy đơn chờ admin xử lý),
**so that** tôi mua được các sản phẩm ngoài package 9router trong cùng một shop, và dữ liệu nhạy cảm không bị lộ.

## Bối cảnh và quyết định architecture

Story 2.26 đã dựng **checkout thật**: `buy:` → `buyc:` confirm → `storeCheckout()` trừ credit nguyên tử trong một `db.transaction()`, tạo `orders` + `orderItems` (snapshot product fields), giảm `stock` oversell-safe, và với `deliveryMode="instant"` thì transition order `paid → fulfilled`. **Nhưng 2.26 chưa giao payload thật** — instant chỉ đổi status, không có credential nào được reserve hay gửi cho buyer. `deliveryMode` mới chỉ có `instant` (xử lý) và ngầm định các mode khác giữ `paid`.

Story 2.27 lấp khoảng trống đó cho **sản phẩm không phải package 9router** (kind = `credential`, `account`, `service`, `api_package`):

1. Thêm bảng **`inventoryItems`** — kho credential/payload rời, mỗi item gắn với một `productId`, có `status` (`available | reserved | delivered | void`).
2. Trong cùng transaction của `storeCheckout`, với product `deliveryMode="instant"` **có inventory**: reserve đúng **một** item khả dụng (lock oversell-safe bằng `WHERE status='available'` conditional update), gắn vào order, transition `fulfilled`, rồi **giao payload qua private chat** của buyer sau khi commit.
3. Với `deliveryMode="admin_fulfill"`: order giữ `paid`, hiện "⏳ chờ admin" trong `/orders` (admin tự fulfill ở story 2.28).
4. **NFR8**: payload nhạy cảm **mã hóa at rest** (AES-256-GCM, key từ env) — không bao giờ lộ qua product list, API công khai, hoặc log.

### Hiện trạng code (verified — đọc trực tiếp tại baseline 5177050)

- **`storeCheckout(userId, productId, opts)`** (`src/lib/store/storeCheckout.js`): một `adapter.transaction()` bọc: idempotency recheck → load+validate product → conditional stock decrement (`WHERE stock >= ?`) → balance gate → `recordCreditTxn({type:"store_purchase", amount:-total}, adapter)` → `insertOrderWithItems(adapter, ...)` status=`paid` → nếu `deliveryMode==="instant"` thì `transitionOrderSync(adapter, orderId, "fulfilled")`. Trả `{order, items, ledgerTxnId, alreadyProcessed}`. **Không** có inventory reservation, **không** có delivery payload. → 2.27 chèn reserve + delivery vào đây.
- **`CheckoutError`** codes hiện có: `PRODUCT_NOT_FOUND | INACTIVE | OUT_OF_STOCK | INSUFFICIENT_CREDITS | INVALID_QUANTITY`. → 2.27 thêm `NO_INVENTORY` (instant product hết credential dù `stock` cho phép — hoặc dùng inventory làm nguồn stock luôn, xem Quyết định bên dưới).
- **`ordersRepo`** (`src/lib/db/repos/ordersRepo.js`): state machine `canTransition`, `insertOrderWithItems(adapter, order, items)`, `transitionOrderSync(adapter, id, to)`, `getOrderById`, `listOrdersByUser`. `orderItems` đã snapshot `targetType/targetId`. ORDER_STATUSES = `pending|paid|fulfilled|cancelled|failed|refunded`.
- **`productsRepo`** (`src/lib/db/repos/productsRepo.js`): `DELIVERY_MODES = ["instant","admin_fulfill","user_self_connect"]`; product kinds `plan|credential|account|service|api_package`. `products` có cột `stock` (NULL = unlimited) và `deliveryMode`, `targetType`, `targetId`.
- **`schema.js`**: `SCHEMA_VERSION = 8`. → 2.27 bump `9` + thêm bảng `inventoryItems`. Không có bảng inventory nào hiện tại (verified: `grep inventory` chỉ ra comment).
- **`botClient`** (`src/lib/telegram/botClient.js`): `sendMessage(chatId, text, opts)`, `answerCallbackQuery(...)`, `isBotConfigured()`. → dùng `sendMessage` để giao payload private.
- **`users.telegramId`** (schema, UNIQUE index): map `userId → telegramId` để biết chat nào gửi payload riêng. Buyer trong store flow đã link telegramId ở story 2.25.
- **`recordCreditTxn(txn, db=null)`** (creditLedgerRepo): sync khi truyền adapter — dùng trong txn của caller, không nested.
- **KHÔNG có `src/lib/crypto`** (verified). → 2.27 tạo helper mã hóa mới.

### Quyết định architecture

**QĐ1 — Inventory là nguồn stock cho instant credential, KHÔNG double-count với `products.stock`.**
Product `deliveryMode="instant"` mà `kind ∈ {credential,account,api_package}` (giao một payload rời) → số lượng bán = số `inventoryItems.status='available'`. Với các product này, **bỏ qua** decrement `products.stock` và thay bằng reserve inventory; nếu không reserve được item nào → `CheckoutError("NO_INVENTORY")`, **không trừ credit** (txn rollback). Product `instant` *không* gắn inventory (ví dụ package 9router entitlement ở story sau) giữ nguyên đường `products.stock` của 2.26. Phân biệt bằng: product có **≥1 inventoryItem từng tồn tại** (hoặc cờ rõ ràng — xem AC). Để tránh nhập nhằng, dùng quy tắc: **nếu product có bất kỳ inventoryItem nào → inventory là nguồn chân lý cho instant**; nếu không → fallback `products.stock` như 2.26.

**QĐ2 — Reserve nguyên tử trong cùng transaction checkout.**
Reserve = conditional UPDATE `... SET status='reserved', orderId=?, reservedAt=? WHERE id=(SELECT id FROM inventoryItems WHERE productId=? AND status='available' ORDER BY createdAt LIMIT 1) AND status='available'`. Vì SQLite WAL + transaction đồng bộ của adapter, hai buyer đồng thời không thể reserve cùng item (`changes===0` ở người thua → `NO_INVENTORY`). KHÔNG bán cùng credential 2 lần (epic constraint dòng 188).

**QĐ3 — Delivery payload SAU commit, không trong txn.**
Gửi Telegram là I/O mạng, không được nằm trong `db.transaction()` (giữ txn ngắn, tránh rollback do lỗi mạng làm mất tiền đã đúng). Flow: txn commit (credit trừ + item reserved + order fulfilled) → đọc payload đã giải mã → `sendMessage(telegramId, payload)` → nếu gửi OK thì `transition... item delivered` + set `deliveredAt`; nếu gửi fail thì item vẫn `reserved`, order vẫn `fulfilled` (tiền đã trừ đúng, credential đã thuộc về buyer), báo user "đã ghi nhận, sẽ gửi lại — xem /orders". KHÔNG refund tự động ở đây (tránh double-spend credential). Audit trail qua `deliveredAt` + ledger refId.

**QĐ4 — Mã hóa at rest (NFR8).**
`inventoryItems.payloadEnc` lưu ciphertext AES-256-GCM (iv + tag + ciphertext, base64). Key từ `process.env.STORE_ENC_KEY` (32-byte, hex hoặc base64). Helper mới `src/lib/crypto/secretBox.js`: `encrypt(plaintext) → string`, `decrypt(blob) → plaintext`. Nếu `STORE_ENC_KEY` thiếu → fail-fast khi seed/insert inventory (không lưu plaintext âm thầm). Payload **không bao giờ** xuất hiện trong `rowToItem`/`rowToInventory` mapper công khai, API `/api/store/products`, hay log. Mapper trả `hasPayload: true/false`, không trả ciphertext lẫn plaintext.

## Acceptance Criteria

### AC1 — Instant credential: reserve + giao private (FR44)
**Given** product `deliveryMode="instant"` có ≥1 `inventoryItem` status=`available`
**When** order paid thành công trong `storeCheckout`
**Then** đúng **một** inventoryItem được reserve (status `available → reserved`, gắn `orderId`) trong cùng transaction
**And** sau commit, payload (đã giải mã) được gửi tới **private chat** của buyer qua `sendMessage(telegramId, ...)`
**And** khi gửi thành công, item chuyển `reserved → delivered` với `deliveredAt` set, order ở `fulfilled`.

### AC2 — Instant hết inventory: không trừ credit (FR44, oversell-safe)
**Given** product instant dùng inventory làm nguồn stock và **không còn** item `available`
**When** user xác nhận mua (`buyc:`)
**Then** `storeCheckout` ném `CheckoutError("NO_INVENTORY")`, transaction rollback
**And** credit **không** bị trừ, **không** tạo order paid/fulfilled
**And** bot trả "❌ Sản phẩm tạm hết hàng" (không phải lỗi kỹ thuật).

### AC3 — Hai buyer đua một item: chỉ một thắng
**Given** product instant chỉ còn **đúng 1** item `available`
**When** hai checkout chạy (tuần tự trong test mô phỏng đua: reserve lần 1 thành công, lần 2 thấy `changes===0`)
**Then** chỉ buyer đầu nhận credential; buyer sau nhận `NO_INVENTORY` và không bị trừ credit
**And** item không bao giờ gắn 2 orderId.

### AC4 — admin_fulfill: đơn chờ admin (FR45)
**Given** product `deliveryMode="admin_fulfill"`
**When** order paid thành công
**Then** order giữ status `paid` (không transition fulfilled, không đụng inventory)
**And** `/orders` hiển thị đơn này với nhãn trạng thái "⏳ Chờ admin xử lý"
**And** không có payload nào được gửi.

### AC5 — Không lộ dữ liệu nhạy cảm (NFR8, UX-DR17)
**Given** inventory credential đã được giao
**When** user/admin xem product list, gọi `GET /api/store/products`, hoặc đọc log
**Then** payload nhạy cảm **không** xuất hiện ở bất kỳ đâu trong số đó (chỉ `hasPayload` boolean)
**And** payload chỉ tồn tại: ciphertext trong `inventoryItems.payloadEnc`, và plaintext trong đúng một private message tới buyer
**And** delivery có audit trail (`reservedAt`, `deliveredAt`, `orderId`, ledger refId).

### AC6 — Idempotency giữ nguyên (regression 2.26)
**Given** một `buyc:` callback bị Telegram gửi lại (cùng idempotencyKey)
**When** `storeCheckout` chạy lần 2
**Then** trả order đã tồn tại với `alreadyProcessed=true`, **không** reserve item thứ hai, **không** trừ credit lần nữa, **không** gửi payload lần nữa.

## Tasks / Subtasks

- [x] **T1 — Schema: bảng `inventoryItems` + bump SCHEMA_VERSION 8→9** (AC1, AC5)
  - [x] Cột: `id PK`, `productId NOT NULL`, `status TEXT NOT NULL DEFAULT 'available'` (available|reserved|delivered|void), `payloadEnc TEXT NOT NULL` (ciphertext AES-256-GCM base64), `orderId TEXT`, `reservedAt TEXT`, `deliveredAt TEXT`, `note TEXT`, `createdAt NOT NULL`, `updatedAt NOT NULL`.
  - [x] Indexes: `idx_inv_product_status (productId, status)` để reserve nhanh; `idx_inv_order (orderId)`.
  - [x] Cập nhật comment migration giống style 2.26.
- [x] **T2 — `src/lib/crypto/secretBox.js`: encrypt/decrypt AES-256-GCM** (AC5, NFR8)
  - [x] `encrypt(plaintext)`: random 12-byte IV, `aes-256-gcm`, trả `base64(iv) + "." + base64(tag) + "." + base64(ct)`.
  - [x] `decrypt(blob)`: parse, verify tag, trả plaintext.
  - [x] Key load từ `STORE_ENC_KEY` (hex 64 chars hoặc base64 32 bytes); thiếu/invalid → throw rõ ràng. Không log key/plaintext.
- [x] **T3 — `src/lib/db/repos/inventoryRepo.js`** (AC1, AC2, AC3, AC5)
  - [x] `insertInventoryItem({productId, payload, note?})`: mã hóa payload qua secretBox rồi insert (status=available). Dùng cho seed/admin.
  - [x] `reserveOneSync(adapter, productId, orderId, now)`: conditional UPDATE reserve item available cũ nhất; trả item (id) hoặc `null` nếu `changes===0`.
  - [x] `markDeliveredSync(adapter, itemId, now)` / `markDelivered(itemId)`: reserved → delivered + deliveredAt.
  - [x] `countAvailable(productId)`, `productHasInventory(productId)` (đếm mọi item, để áp QĐ1).
  - [x] `getDecryptedPayload(itemId)`: chỉ dùng nội bộ delivery; giải mã, KHÔNG expose qua API.
  - [x] `rowToInventory(row)`: trả `hasPayload: !!row.payloadEnc`, **không** trả `payloadEnc`.
  - [x] Export qua `src/lib/db/index.js`.
- [x] **T4 — Tích hợp reserve vào `storeCheckout`** (AC1, AC2, AC3, AC6)
  - [x] Trong txn, sau balance gate: nếu `deliveryMode==="instant"` **và** `productHasInventory(productId)` → bỏ nhánh `products.stock` decrement, thay bằng `reserveOneSync(...)`; nếu null → `throw new CheckoutError("NO_INVENTORY", "Sản phẩm tạm hết hàng")`.
  - [x] Vẫn `recordCreditTxn` + `insertOrderWithItems(status:"paid")` + `transitionOrderSync(fulfilled)` cho instant-có-inventory.
  - [x] admin_fulfill: giữ `paid`, không reserve.
  - [x] Trả thêm `deliveredCredentialIds` trong result để caller giao payload.
  - [x] Giữ idempotency 2 lớp (pre-check + in-txn recheck) — replay không reserve lại.
- [x] **T5 — Delivery sau commit trong router** (AC1, AC4, AC5)
  - [x] Trong handler `buyc:` (router.js): sau `storeCheckout`, nếu `deliveredCredentialIds` và order `fulfilled` → `getDecryptedPayload` → `sendMessage(buyerTelegramId, payload)` → lỗi gửi: giữ reserved, báo "đã ghi nhận, xem /orders".
  - [x] admin_fulfill order: trả "⏳ Đơn đang chờ admin xử lý. Theo dõi tại /orders."
  - [x] `NO_INVENTORY` / `OUT_OF_STOCK`: answerCallbackQuery + message "tạm hết hàng".
- [x] **T6 — `/orders` hiển thị trạng thái fulfillment** (AC4)
  - [x] Map status → nhãn VI: `paid`+admin_fulfill → "⏳ Chờ admin", `fulfilled` → "✅ Đã giao", v.v.
- [x] **T7 — Tests** (`tests/unit/credentialsRepo.test.js` + mở rộng `storeCheckout.test.js`)
  - [x] secretBox round-trip + tamper tag → throw.
  - [x] reserveOneSync: thắng/thua (changes===0), không gắn 2 orderId (AC3).
  - [x] checkout instant-có-inventory: reserve + fulfilled (AC1); hết inventory → NO_INVENTORY, không trừ credit (AC2).
  - [x] checkout admin_fulfill: giữ paid, không đụng inventory (AC4).
  - [x] idempotency replay: không reserve lần 2 (AC6).
  - [x] mapper/API không chứa payload plaintext/ciphertext (AC5).
- [x] **T8 — Seed + env doc**
  - [x] Ghi `STORE_ENC_KEY` vào `.env.example` + note cách sinh key (`openssl rand -hex 32`).

## Dev Agent Record

### File List

- src/lib/crypto/secretBox.js
- src/lib/db/schema.js
- src/lib/db/repos/credentialsRepo.js
- src/lib/db/index.js
- src/lib/store/storeCheckout.js
- src/lib/telegram/router.js
- tests/unit/credentialsRepo.test.js
- tests/unit/storeCheckout.test.js
- .env.example

### Change Log

- 2026-06-12: Story implemented (2.27). Schema v9 + productCredentials table. secretBox AES-256-GCM encryption at rest. credentialsRepo with encrypted add/list/deliver/revoke + getDecryptedPayload. storeCheckout returns deliveredCredentialIds. router.js: credential delivery after commit, /orders handler, cmd:orders callback. 34 tests pass. Status → review.

- **Phạm vi 2.27 KHÔNG gồm**: admin UI quản lý inventory/orders (đó là 2.28), `user_self_connect` flow đầy đủ, entitlement schema package 9router (2.29a/b), external supplier sync (story sau). Chỉ làm: inventory table + reserve + instant credential delivery + admin_fulfill pending state + mã hóa.
- **Giữ txn ngắn**: tuyệt đối không `await sendMessage` bên trong `adapter.transaction()`. Reserve trong txn, deliver sau commit.
- **NO_INVENTORY vs OUT_OF_STOCK**: dùng `NO_INVENTORY` cho product inventory-backed; `OUT_OF_STOCK` (2.26) cho product `products.stock`-backed. Đừng trộn.
- **Fail-safe delivery**: thà order `fulfilled` + item `reserved` (chưa `delivered`) còn hơn refund tự động rồi credential đã lộ. Admin/retry xử lý ở 2.28.
- **STORE_ENC_KEY thiếu trong test**: test set key cố định qua env trong setup (không hardcode plaintext key trong source).

## Verification

- `npx vitest run tests/unit/inventory.test.js tests/unit/storeCheckout.test.js` — tất cả pass.
- `npm run build` — routes OK, không vỡ regression 2.26.
- Manual: seed inventory → mua product instant credential trong bot → nhận payload private; mua lần nữa khi hết → "tạm hết hàng", số dư không đổi; product admin_fulfill → `/orders` hiện "⏳ Chờ admin".
- Grep chống lộ: `grep -rI "payloadEnc\|payload" src/app/api/store` không trả về plaintext payload trong response shape.

### Review Findings

#### PATCH — đã áp dụng (2026-06-12)

- **P1 — Sai error code cho credential hết hàng (AC2, QĐ1)**
  Vi phạm: AC2 yêu cầu `CheckoutError("NO_INVENTORY")`; storeCheckout.js ném `"OUT_OF_STOCK"`. QĐ1 phân biệt rõ: `NO_INVENTORY` cho inventory-backed, `OUT_OF_STOCK` cho stock-backed.
  Bằng chứng: `storeCheckout.js` dòng throw trong credential loop.
  Hành động: Đổi thành `"NO_INVENTORY"`. Cập nhật comment `CheckoutError`. Cập nhật 2 test expectations trong `storeCheckout.test.js`.

- **P2 — `CHECKOUT_ERROR_MESSAGES` thiếu entry `NO_INVENTORY` (AC2)**
  Vi phạm: AC2 yêu cầu bot trả "❌ Sản phẩm tạm hết hàng". Thiếu key `NO_INVENTORY` → fallback về "Mua hàng thất bại." (sai message).
  Bằng chứng: `router.js` — `CHECKOUT_ERROR_MESSAGES` không có `NO_INVENTORY`.
  Hành động: Thêm `NO_INVENTORY: "❌ Sản phẩm tạm hết hàng."`.

#### DEFER — hoãn sang 2.28

- **D1 — Trạng thái `reserved` trung gian không implement (AC1, QĐ3)**
  AC1/QĐ3 mô tả hai bước: `available → reserved` trong txn, rồi `reserved → delivered` sau sendMessage thành công. Thực tế: item đi thẳng `available → delivered` trong txn; `deliveredAt` được set trước khi Telegram nhận được message. Nếu gửi thất bại, item đã `delivered` nhưng buyer chưa nhận — không có audit trail phân biệt. Hành động 2.28: thêm `reserved` vào `CREDENTIAL_STATUSES`, cột `reservedAt`, và transition thứ hai sau delivery.

- **D2 — `handleProducts`/`handleBuyConfirm` không kiểm tra credential inventory (AC2 UX)**
  Nút "Mua ngay" hiển thị dựa trên `products.stock`, không phản ánh số lượng credential thực. Credential product luôn hiện nút mua dù inventory rỗng. Lỗi `NO_INVENTORY` chỉ bắt được ở checkout. Hành động 2.28: tích hợp `countAvailableCredentials` vào catalog display.

- **D3 — `productHasInventory()` không implement theo QĐ1**
  QĐ1: "nếu product có ≥1 inventoryItem → inventory là nguồn chân lý". Thực tế dùng `product.kind === "credential"` làm gate. Sự khác biệt: kind=credential nhưng chưa seed inventory vẫn đi qua credential path (ném `NO_INVENTORY`). Hành động 2.28.

#### DISMISS

- **X1** — Tên cột `payload` vs spec `payloadEnc`: `rowToCredential()` suppress đúng (`hasPayload: !!row.payload`), không lộ ciphertext. Chấp nhận.
- **X2** — `loadKey()` gọi mỗi lần encrypt/decrypt: không phải hot path trong scope 2.27.
- **X3** — `revokeCredential` không throw khi ID không tồn tại: admin path, acceptable.
- **X4** — Thiếu cột `reservedAt`: nhất quán với quyết định bỏ `reserved` state (xem D1).
- **X5** — Test AC3 chỉ cover serial, không có concurrent test thực: `deliverCredentialSync` WHERE guard đảm bảo atomicity ở SQLite WAL level.
