---
baseline_commit: 4d52aac
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture-store.md
  - docs/stories/2-30-external-telegram-store-sources-catalog-sync.md
  - docs/stories/2-31-external-product-markup-publishing.md
  - docs/stories/2-35-reseller-apikey-code-inventory.md
  - src/lib/db/schema.js
  - src/lib/store/storeCheckout.js
  - src/lib/store/catalogSync.js
  - src/lib/store/suppliers/index.js
  - src/lib/db/repos/ordersRepo.js
  - src/lib/telegram/router.js
---

# Story 2.32: External Vendor Checkout & Supplier QR Handoff

Status: done

## Story

As a buyer,
I want mua external product trong bot store của bạn và nhận payment instructions HỢP LỆ (đảm bảo store giữ được margin),
so that tôi thanh toán đúng flow đã được admin cấu hình mà vẫn mua qua store của bạn — KHÔNG bao giờ bị đưa QR wholesale gốc của supplier.

## Bối cảnh và quyết định architecture

> **Story này là bước tiếp theo của nhánh external-store sau 2.30 (source + sync) và 2.31 (markup + publishing).** 2.32 = **vendor checkout cho external product + payment-mode gate + supplier-order tracking**. KHÔNG đụng routing. Reuse hot-path `storeCheckout` cho path `proxy_checkout`, KHÔNG sửa logic trừ tiền hiện có.

### ⚠️ Reality check — đọc TRƯỚC khi implement (verified tại baseline 4d52aac)

Hai sự thật về codebase định hình toàn bộ scope story này. Dev PHẢI hiểu trước khi code:

1. **Supplier adapter hiện 100% READ-ONLY.** `src/lib/store/suppliers/` có 4 adapter (`supplier_api`, `channel_feed`, `polling_feed`, `webhook`), mỗi adapter export ĐÚNG 3 method: `validate(config)`, `fetchCatalog(source, auth)`, `normalizeProduct(raw)`. **KHÔNG có** bất kỳ method ghi phía supplier nào: không `createOrder`, không `createInvoice`, không `getQR`, không `placeOrder`. Toàn bộ integration là catalog-consumer một chiều (GET catalog + nhận webhook). [Source: src/lib/store/suppliers/index.js; docs/stories/2-30...md#QĐ3]
   > ⚠️ **Name collision — đọc kỹ:** `src/lib/store/suppliers/index.js` export `getAdapter(adapterType)` trả **supplier adapter module** (theo adapterType string). Đây KHÁC HOÀN TOÀN `getAdapter()` của `src/lib/db/driver.js` (trả **DB/SQLite adapter**). Trong story này: "**supplierAdapter**" = module từ `suppliers/index.js`; "**adapter**"/"**db**" = DB adapter. KHÔNG nhầm hai cái. `supportsVendorOrder(supplierAdapter)` nhận supplier adapter, KHÔNG phải DB adapter.

2. **Epic AC 2.32 mô tả `vendor_commission` là path chính** (supplier tạo invoice/QR với commission hoặc retail amount). **KHÔNG supplier nào trong MVP hỗ trợ điều này** — vì adapter read-only và không có supplier thật nào đã verify hỗ trợ commission/custom-invoice API. Epic CŨNG đã mô tả nhánh fallback (`proxy_checkout`/`separate_fee`/disable) cho đúng tình huống "supplier chỉ có QR wholesale gốc".

**Hệ quả (quyết định scope — best practice, YAGNI + match reality):** 2.32 KHÔNG build pipeline `vendor_commission` đầy đủ (createOrder/createInvoice/getQR) vì nó **speculative** (không test được với supplier thật, vi phạm YAGNI, đúng anti-pattern "invent schema/capability cho story sau"). Thay vào đó 2.32 build:

- **Capability detection** — adapter khai báo có hỗ trợ vendor-order-creation không (`supportsVendorOrder()`); mặc định tất cả adapter hiện tại = `false`.
- **Payment-mode gate (CỐT LÕI của story)** — đảm bảo KHÔNG BAO GIỜ đưa QR wholesale gốc của supplier cho user (vì giá đó = supplierPrice, store mất margin + lộ giá gốc). Đây là requirement an toàn business chính của epic AC3/AC4.
- **`proxy_checkout` path** — user trả credit 9router (= retailPrice qua `priceCredits`, đã set bởi 2.31 markup), reuse `storeCheckout` HOÀN TOÀN không sửa; order chuyển `admin_fulfill` flow (admin/sync đặt đơn upstream). Đây là path KHẢ THI ngay hôm nay.
- **`supplierOrders` tracking table** — ghi supplier-side order state để 2.33 (status sync) + 2.34 (reconciliation) build tiếp.
- **`vendor_commission` path** — chỉ stub + reject rõ ràng ("supplier chưa hỗ trợ vendor invoice"), interface sẵn sàng cho khi có supplier thật (story riêng kích hoạt).

> **Quan hệ với 2.35:** story `2-35-reseller-apikey-code-inventory` (đang `ready-for-dev`) bán external product (v98store/viber.vn) qua `productCredentials` + `storeCheckout` sẵn có — đó là mô hình "inventory nội bộ" (store đã có sẵn hàng/key). 2.32 KHÁC: 2.32 lo external product **sync từ supplier** (2.30/2.31, `source='external_telegram_store'`) nơi store CHƯA giữ hàng, phải đặt đơn upstream. Hai story bổ sung nhau, không chồng lấn: 2.35 = reseller-with-own-inventory; 2.32 = dropship-from-supplier. `proxy_checkout` của 2.32 = "trừ credit user, đơn vào hàng đợi admin/sync fulfill upstream".

### Hiện trạng code (verified tại baseline 4d52aac)

- **`storeCheckout(userId, productId, { quantity, idempotencyKey, now })`** (`src/lib/store/storeCheckout.js`): atomic `adapter.transaction()` — idempotency recheck → load+validate product → conditional stock decrement → balance gate → `recordCreditTxn({type:'store_purchase', amount:-totalCredits, refId:orderId, idempotencyKey:'store:'+orderId}, adapter)` → `insertOrderWithItems(adapter, {status:'paid', deliveryMode, ledgerTxnId, idempotencyKey}, items)` → branch theo `deliveryMode` (instant credential / admin_fulfill / user_self_connect). Đọc giá qua `product.priceCredits`. `CheckoutError` codes: `PRODUCT_NOT_FOUND|INACTIVE|OUT_OF_STOCK|NO_INVENTORY|INSUFFICIENT_CREDITS|INVALID_QUANTITY`.
- **`orders` table** (`schema.js`): `id, userId, status, source DEFAULT 'telegram', totalCredits, deliveryMode, ledgerTxnId, idempotencyKey, note, fulfilledAt, createdAt, updatedAt`. **KHÔNG có cột supplier nào.** `orderItems`: snapshot fields (productName/kind/deliveryMode/targetType/targetId/unitCredits/quantity).
- **`ordersRepo.js`**: `insertOrderWithItems`, `transitionOrderSync`, `transitionOrder`, `getOrderByIdempotencyKeySync`, `getOrderById`, `getOrderWithItems`, `setFulfilledAt`, `canTransition(from,to)`, `ORDER_STATUSES = [pending,paid,fulfilled,cancelled,failed,refunded]`. State machine: `pending→paid→fulfilled→refunded`, `paid→cancelled|failed`.
- **`products`** có (2.30/2.31): `source`, `supplierSourceId`, `supplierProductId`, `supplierPrice`, `retailPrice`, `expectedMargin`, `isPublished`, `priceCredits` (= retailPrice sau markup). `EXTERNAL_SOURCE='external_telegram_store'`.
- **`supplierSources`** (2.30): `id, name, adapterType, authEnc, syncMode, syncIntervalSec, status, lastSyncedAt, lastSyncError, syncVersion, isActive, ...`. Chưa có cột `paymentMode` — 2.32 thêm qua migration 012 (QĐ2).
- **`botClient.js`**: `sendMessage`, `answerCallbackQuery`, `setWebhook`, `isBotConfigured`. **KHÔNG có `sendPhoto`** (cần thêm nếu hiển thị QR image).
- **`markupEngine.js`**: `getEffectivePrice(product)` (read-only display helper) trả `retailPrice ?? priceCredits`; `calculateRetailPrice`, `applyMarkupToProduct`, `publishProduct`/`unpublishProduct`. ⚠️ `priceCredits` được SET = `retailPrice` bởi `applyMarkupToProduct` (KHÔNG phải bởi `getEffectivePrice`). **`storeCheckout` charge `product.priceCredits`** (storeCheckout.js:93 `unitCredits = product.priceCredits`), KHÔNG đọc `retailPrice` trực tiếp. Hệ quả cho 2.32: margin guard phải verify `priceCredits === retailPrice` (xem QĐ5/T4) — nếu product sync trước 2.31 mà chưa chạy `applyMarkupToProduct`, `priceCredits` có thể ≠ `retailPrice` → user bị charge sai, margin âm thầm hao.
- **`SCHEMA_VERSION = 13`** (`schema.js`). Migration mới nhất: `011-markup-rules.js` (version 11). Slot 012 trống.
- **`recordCreditTxn`/`reverseTxn`** (`creditLedgerRepo.js`): E7 dual-mode (optional `db` adapter, inline sync khi đã trong transaction). `reverseTxn` cho refund (BP-1 immutable, idempotent `reversal:${originalId}`).

### Quyết định architecture (chốt cho story này)

- **QĐ1 — Enum `PAYMENT_MODES`** (E8 enum tập trung, `src/lib/store/constants.js` mới hoặc trong repo): `["proxy_checkout", "vendor_commission", "separate_fee", "disabled"]`.
  - `proxy_checkout` — user trả credit 9router (= retailPrice), store đặt đơn upstream qua admin/sync. **Path khả thi MVP.**
  - `vendor_commission` — supplier tạo invoice/QR với retail/commission amount. **Stub MVP** — reject "supplier chưa hỗ trợ" tới khi adapter `supportsVendorOrder()=true`.
  - `separate_fee` — user trả QR wholesale gốc của supplier cho phần gốc + trả riêng phần margin cho store (qua credit). **Stub MVP** (cần QR gốc từ supplier — không có capability). Reject rõ ràng.
  - `disabled` — admin tắt bán external product này. Checkout reject `PRODUCT_DISABLED`.

- **QĐ2 — `paymentMode` lưu ở `supplierSources` (default) + override per-product** (best practice — flexible, ít lặp):
  - `supplierSources.paymentMode TEXT DEFAULT 'proxy_checkout'` — mặc định cho mọi product của nguồn.
  - `products.paymentModeOverride TEXT` (nullable) — override per-product; null = dùng default của source.
  - Resolver `resolvePaymentMode(product, source)`: `product.paymentModeOverride ?? source.paymentMode ?? 'proxy_checkout'`.

- **QĐ3 — Bảng `supplierOrders` riêng** (best practice — tách external concern khỏi `orders` core, giống Epic I tách entitlements khỏi orders):
  ```
  id TEXT PRIMARY KEY,
  orderId TEXT NOT NULL,            -- FK-less ref orders.id (internal order)
  supplierSourceId TEXT NOT NULL,   -- FK-less ref supplierSources.id
  supplierProductId TEXT,           -- ref products.supplierProductId (snapshot)
  paymentMode TEXT NOT NULL,        -- snapshot PAYMENT_MODES tại checkout
  supplierOrderId TEXT,             -- id đơn phía supplier (null tới khi đặt được)
  supplierInvoiceId TEXT,           -- id invoice phía supplier (vendor_commission)
  qrPayload TEXT,                   -- QR/payment instruction từ supplier (KHÔNG phải wholesale gốc)
  supplierPrice REAL,               -- snapshot giá gốc tại checkout (audit margin)
  retailPrice REAL,                 -- snapshot giá bán tại checkout
  expectedMargin REAL,              -- snapshot retailPrice - supplierPrice
  supplierStatus TEXT,              -- trạng thái phía supplier (raw, cho 2.33 sync)
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  -- Index: idx_supplier_order_order(orderId), idx_supplier_order_source(supplierSourceId)
  ```
  Mỗi internal order external có ≥1 supplierOrders row. `supplierOrderId/supplierInvoiceId/qrPayload` null lúc tạo (proxy_checkout: đặt sau bởi admin; vendor_commission: đặt bởi adapter — chưa có).

- **QĐ4 — Adapter capability detection** (mở rộng contract NHẸ, backward-compat): thêm method optional `supportsVendorOrder()` trả boolean, default `false` cho mọi adapter hiện tại (qua base default trong registry hoặc check `typeof adapter.createSupplierOrder === 'function'`). KHÔNG bắt buộc adapter cũ implement. `vendor_commission`/`separate_fee` chỉ chạy khi `supportsVendorOrder()===true`; ngược lại reject. **KHÔNG thêm createOrder/createInvoice/getQR thật** (speculative — defer tới story có supplier thật).

- **QĐ5 — `externalCheckout(userId, productId, opts)` trong `src/lib/store/externalCheckout.js` mới** (KHÔNG sửa `storeCheckout.js`):
  - Load product, assert `source === EXTERNAL_SOURCE` + `isPublished=1` + `isActive=1` (gate 2.31).
  - Load source, `resolvePaymentMode(product, source)`.
  - **Margin guard (CỐT LÕI — epic AC3/AC4):** verify `retailPrice != null && retailPrice > supplierPrice` (margin dương). Nếu vi phạm → reject `MARGIN_VIOLATION`, KHÔNG checkout. ⚠️ THÊM: verify `product.priceCredits === product.retailPrice` (vì `storeCheckout` charge `priceCredits`, không phải `retailPrice` — storeCheckout.js:93). Nếu lệch (product sync trước 2.31 chưa apply markup) → reject `MARGIN_VIOLATION` ("giá chưa đồng bộ — admin apply markup lại"). Tránh charge user < retailPrice, hao margin âm thầm.
  - Branch theo paymentMode:
    - `proxy_checkout` → gọi `storeCheckout(userId, productId, opts)` (reuse — trừ credit retailPrice, order→paid, `deliveryMode='admin_fulfill'` flow) + tạo `supplierOrders` row (`paymentMode='proxy_checkout'`, snapshot giá, `supplierOrderId=null` chờ admin/sync đặt) trong CÙNG transaction (E7 — pass adapter).
    - `vendor_commission`/`separate_fee` → check `supportsVendorOrder()`; false → reject `VENDOR_MODE_UNSUPPORTED` ("supplier chưa hỗ trợ vendor invoice — admin chọn proxy_checkout hoặc disable"). true → (defer path, chưa có supplier).
    - `disabled` → reject `PRODUCT_DISABLED`.
  - Idempotency: reuse pattern `storeCheckout` (`store:${orderId}`); `supplierOrders` insert idempotent theo `orderId` (UNIQUE-guard hoặc recheck trong txn).

- **QĐ6 — TUYỆT ĐỐI KHÔNG đưa raw wholesale QR cho user** (epic AC3/AC4 — requirement an toàn chính):
  - Nếu một path nào đó nhận được QR từ supplier mà amount = supplierPrice (wholesale) → KHÔNG hiển thị cho user. Chỉ hiển thị QR khi amount đã xác nhận = retailPrice (hoặc commission-adjusted). Vì MVP không có supplier tạo invoice retail → vendor_commission luôn reject → không có QR nào được hiển thị cho user trong MVP. `proxy_checkout` user trả credit 9router (không QR supplier).
  - Guard này phải có TEST: giả lập supplier trả QR wholesale → assert hệ thống KHÔNG forward cho user, order chuyển mode khác hoặc block.

- **QĐ7 — Idempotency (epic AC5 — Telegram callback/supplier-order-create retry)**:
  - Internal order: reuse `orders.idempotencyKey` (NFR7, pattern 2.26 `tg:${telegramId}:${productId}:${callbackQueryId}`).
  - `supplierOrders`: 1 internal order → KHÔNG tạo nhiều supplierOrders row. Recheck `getSupplierOrderByOrderIdSync(adapter, orderId)` trong transaction trước insert; nếu đã có → return existing (alreadyProcessed). User chỉ nhận 1 payment instruction hiện hành.

- **QĐ8 — KHÔNG đụng routing/billing-core**: 2.32 chỉ thêm external checkout path + supplier-order tracking. KHÔNG sửa `storeCheckout.js` (reuse as-is), KHÔNG sửa `getProviderCredentials`/routing, KHÔNG sửa `recordCreditTxn`/`reverseTxn` (reuse). Vendor settlement/reconciliation = 2.34.

- **QĐ9 — Bot UI handoff**: `proxy_checkout` thành công → bot gửi text "Đơn đã tạo, đang xử lý với nhà cung cấp" (reuse `sendMessage`, `admin_fulfill` flow của 2.26 — user chờ admin/sync fulfill). KHÔNG cần `sendPhoto` cho MVP (vì không hiển thị QR supplier — vendor_commission defer). `sendPhoto` defer tới story kích hoạt vendor_commission thật.

## Acceptance Criteria

### AC1 — Checkout external product tạo internal order + supplierOrders idempotent
**Given** user chọn mua external product đã publish (`source='external_telegram_store'`, `isPublished=1`, `isActive=1`) với `paymentMode='proxy_checkout'`
**When** user xác nhận checkout
**Then** hệ thống tạo internal order (reuse `storeCheckout`, trừ credit = `retailPrice`, order→paid) VÀ tạo `supplierOrders` row trong CÙNG transaction
**And** `supplierOrders` lưu `orderId, supplierSourceId, supplierProductId, paymentMode, supplierPrice, retailPrice, expectedMargin` (snapshot tại checkout); `supplierOrderId/supplierInvoiceId/qrPayload` = null (chờ admin/sync đặt upstream).

### AC2 — Margin guard: reject khi retailPrice <= supplierPrice
**Given** external product có `retailPrice` chưa set HOẶC `retailPrice <= supplierPrice` (margin không dương — admin chưa apply markup hợp lệ)
**When** user checkout
**Then** hệ thống reject với `MARGIN_VIOLATION` ("sản phẩm chưa có giá bán hợp lệ — liên hệ admin")
**And** KHÔNG tạo order, KHÔNG trừ credit.

### AC3 — KHÔNG BAO GIỜ đưa raw wholesale QR cho user (an toàn margin)
**Given** supplier chỉ cung cấp QR gốc giá wholesale (= supplierPrice) và KHÔNG hỗ trợ commission/custom retail invoice (`supportsVendorOrder()===false`)
**When** product cấu hình `paymentMode='vendor_commission'` hoặc `'separate_fee'`
**Then** hệ thống KHÔNG dùng/forward QR gốc đó cho user
**And** checkout reject `VENDOR_MODE_UNSUPPORTED` với hướng dẫn admin chọn `proxy_checkout` hoặc `disabled`
**And** có test giả lập supplier trả QR wholesale → assert hệ thống KHÔNG forward cho user.

### AC4 — paymentMode='disabled' chặn bán
**Given** admin set `paymentModeOverride='disabled'` cho product (hoặc source default `disabled`)
**When** user checkout
**Then** hệ thống reject `PRODUCT_DISABLED` ("sản phẩm tạm ngừng bán")
**And** KHÔNG tạo order.

### AC5 — Idempotency: callback/retry không tạo nhiều supplierOrders
**Given** Telegram callback hoặc checkout request bị retry với cùng idempotencyKey
**When** cùng key được xử lý lại
**Then** KHÔNG tạo internal order thứ 2 (reuse `orders.idempotencyKey` recheck của storeCheckout)
**And** KHÔNG tạo `supplierOrders` row thứ 2 cho cùng internal order (recheck `getSupplierOrderByOrderIdSync` trong transaction)
**And** user chỉ nhận một payment instruction / xác nhận hiện hành.

### AC6 — Backward-compat: local product + internal checkout KHÔNG đổi
**Given** toàn bộ thay đổi 2.32
**When** user checkout product `source='local'` (2.26-2.28) hoặc product external bán qua inventory nội bộ (2.35)
**Then** `storeCheckout` hành vi KHÔNG đổi (KHÔNG sửa file đó)
**And** `orders`/`orderItems`/`recordCreditTxn` schema + logic KHÔNG đổi (chỉ THÊM bảng `supplierOrders` + cột `paymentMode`/`paymentModeOverride` nullable)
**And** full unit suite pass.

## Tasks / Subtasks

- [x] **T1 — Schema: `supplierOrders` table + paymentMode cột + migration** (AC1, AC4, AC6)
  - [x] Thêm enum `PAYMENT_MODES = ['proxy_checkout','vendor_commission','separate_fee','disabled']` (E8) — `src/lib/store/constants.js` mới (hoặc trong `supplierSourcesRepo.js` cạnh ADAPTER_TYPES nếu giữ pattern hiện có). Đồng thời gom các store enum khác nếu hợp lý.
  - [x] Thêm bảng `supplierOrders` vào `TABLES` (schema.js) camelCase (QĐ3) + index `idx_supplier_order_order(orderId)`, `idx_supplier_order_source(supplierSourceId)`.
  - [x] Thêm `supplierSources.paymentMode TEXT DEFAULT 'proxy_checkout'` (QĐ2).
  - [x] Thêm `products.paymentModeOverride TEXT` (nullable — null = dùng source default; local product luôn null, backward-compat).
  - [x] Bump `SCHEMA_VERSION = 14`.
  - [x] Tạo `src/lib/db/migrations/012-supplier-orders.js` (**version 12** — slot 011 đã bị `011-markup-rules.js` chiếm): guard `tableExists`/column-present, `CREATE TABLE IF NOT EXISTS supplierOrders`, `ALTER supplierSources ADD COLUMN paymentMode` + `ALTER products ADD COLUMN paymentModeOverride` nếu thiếu. Đăng ký `migrations/index.js` (import `m012`, append). ⚠️ KHÔNG dùng version ≤ 11 (collision).
  - [x] Verify local product (`source='local'`, `paymentModeOverride=null`) KHÔNG bị ảnh hưởng; backward-compat.

- [x] **T2 — `supplierOrdersRepo.js`** (AC1, AC5) — `src/lib/db/repos/supplierOrdersRepo.js`
  - [x] `insertSupplierOrderSync(adapter, data)` — sync, gọi trong caller transaction (E7). Snapshot supplierPrice/retailPrice/expectedMargin/paymentMode.
  - [x] `getSupplierOrderByOrderIdSync(adapter, orderId)` — sync recheck idempotency (AC5).
  - [x] `getSupplierOrderByOrderId(orderId)` — async.
  - [x] `updateSupplierOrderStatus(id, { supplierOrderId, supplierInvoiceId, qrPayload, supplierStatus })` — async (dùng cho 2.33 sync sau).
  - [x] `listSupplierOrders({ supplierSourceId, status, limit, offset })` — async (admin view 2.34).
  - [x] `findPaidExternalOrdersMissingSupplierOrder()` — async; trả internal order `paid` + external nhưng KHÔNG có `supplierOrders` row (orphan detection cho recovery, QĐ5 CRITICAL). Vì `orders` không có cột source, JOIN qua orderItems→products:
    ```sql
    SELECT o.* FROM orders o
    JOIN orderItems oi ON oi.orderId = o.id
    JOIN products p ON p.id = oi.productId
    LEFT JOIN supplierOrders so ON so.orderId = o.id
    WHERE o.status = 'paid' AND p.source = 'external_telegram_store' AND so.id IS NULL
    ```
  - [x] Export qua `src/lib/db/index.js`.

- [x] **T2b — `ordersRepo.js` thêm `setOrderNoteSync`** (QĐ5 orphan recovery)
  - [x] `setOrderNoteSync(adapter, orderId, note)` — sync, set `orders.note` KHÔNG đổi status (vì `transitionOrderSync` chỉ set note kèm transition; orphan-flag phải giữ order `paid`). Dùng để đánh dấu order cần reconcile khi supplierOrders insert fail.

- [x] **T3 — Payment-mode resolver + capability detection** (AC3, QĐ2/QĐ4)
  - [x] `resolvePaymentMode(product, source)` — `product.paymentModeOverride ?? source.paymentMode ?? 'proxy_checkout'` (validate ∈ PAYMENT_MODES). Đặt ở `externalCheckout.js` hoặc `markupEngine.js`.
  - [x] `supportsVendorOrder(adapter)` — trả `typeof adapter.createSupplierOrder === 'function'` (default false cho 4 adapter hiện tại). KHÔNG implement createSupplierOrder thật (defer).
  - [x] Document rõ trong code: vendor_commission/separate_fee là defer-path, chỉ chạy khi adapter khai báo capability.

- [x] **T4 — `externalCheckout.js`** (AC1-AC5, QĐ5/QĐ6) — `src/lib/store/externalCheckout.js` mới
  - [x] `class ExternalCheckoutError(code, message)` — codes: `NOT_EXTERNAL | NOT_PUBLISHED | MARGIN_VIOLATION | VENDOR_MODE_UNSUPPORTED | PRODUCT_DISABLED | SUPPLIER_NOT_FOUND` (+ re-throw CheckoutError từ storeCheckout).
  - [x] `externalCheckout(userId, productId, { quantity, idempotencyKey, now })`:
    - Load product; assert `source===EXTERNAL_SOURCE` (else `NOT_EXTERNAL`), `isPublished=1 && isActive=1` (else `NOT_PUBLISHED`).
    - Load supplierSource (`getSupplierSourceById`); else `SUPPLIER_NOT_FOUND`.
    - Margin guard (AC2): `retailPrice != null && retailPrice > supplierPrice` else `MARGIN_VIOLATION`.
    - `resolvePaymentMode` → branch:
      - `disabled` → throw `PRODUCT_DISABLED`.
      - `vendor_commission`/`separate_fee` → `supportsVendorOrder()` false → throw `VENDOR_MODE_UNSUPPORTED` (QĐ6 — KHÔNG forward QR wholesale). true → defer (throw `VENDOR_MODE_UNSUPPORTED` cho MVP với note "chưa có supplier thật").
      - `proxy_checkout` → `storeCheckout(userId, productId, opts)` (reuse) → sau đó insert `supplierOrders` row. ⚠️ `storeCheckout` mở transaction riêng → option (a): insert `supplierOrders` ở transaction phụ SAU khi storeCheckout commit (giữ "KHÔNG sửa storeCheckout" QĐ8).
    - ⚠️ **CRITICAL — retry path (C-2, AC5):** Luôn chạy bước insert supplierOrders bất kể `alreadyProcessed`, recheck tồn tại trước (idempotent).
    - ⚠️ **CRITICAL — orphan recovery (money path):** Wrap insert phụ trong try/catch; nếu fail → log error + flag `orders.note` cần reconcile via `setOrderNoteSync`. KHÔNG refund.
  - [x] Return `{ order, supplierOrder, paymentMode, alreadyProcessed }`.

- [x] **T5 — Bot UI integration** (AC1, QĐ9) — `src/lib/telegram/router.js`
  - [x] `handleBuyExecute`: detect external product (`source===EXTERNAL_SOURCE`) → route qua `externalCheckout` thay vì `storeCheckout`. Local product giữ nguyên `storeCheckout`.
  - [x] Map `ExternalCheckoutError` codes → message tiếng Việt. THÊM branch `e instanceof ExternalCheckoutError` riêng + tạo map `EXTERNAL_CHECKOUT_ERROR_MESSAGES`.
  - [x] proxy_checkout thành công → `sendMessage` "✅ Đơn #... đã tạo. Đang xử lý với nhà cung cấp, bạn sẽ nhận hàng sớm."
  - [x] KHÔNG thêm `sendPhoto` (defer — vendor_commission chưa active).

- [x] **T6 — API route admin [OPTIONAL — defer sang 2.34]** (AC1) — deferred, không block AC nào.

- [x] **T7 — Tests** (AC1-AC6)
  - [x] `tests/unit/externalCheckout.test.js` (mới): 25 tests pass.
  - [x] **AC3 guard test (CRITICAL)**: adapter với `getQR` nhưng không có `createSupplierOrder` → `supportsVendorOrder()=false` → vendor mode reject sạch.
  - [x] **AC5 idempotency**: 2 lần cùng idempotencyKey → 1 order + 1 supplierOrders row.
  - [x] **Orphan recovery (QĐ5 CRITICAL)**: delete supplierOrders row simulate fail → retry bù được row; `findPaidExternalOrdersMissingSupplierOrder()` phát hiện đúng.
  - [x] `tests/unit/supplierOrdersRepo.test.js` (mới): 10 tests pass.
  - [x] `tests/unit/supplier-orders-migration.test.js` (mới): 6 tests pass.
  - [x] **Regression (AC6)**: full suite 1562 pass / 3 pre-existing fail (unrelated) / 58 skip.

## Dev Notes

### Ràng buộc bắt buộc

- **KHÔNG sửa `storeCheckout.js`** (QĐ8) — reuse as-is cho proxy_checkout. Nếu thấy "cần sửa storeCheckout" → DỪNG, lệch scope; dùng wrapper `externalCheckout`.
- **KHÔNG đụng routing** (`getProviderCredentials`/`auth.js`) — 2.32 chỉ checkout + tracking. (Phân biệt với 2.29b đã chạm routing.)
- **KHÔNG build createSupplierOrder/createInvoice/getQR thật** — speculative, không test được với supplier thật, vi phạm YAGNI + anti-pattern "invent capability cho story sau". Chỉ stub + capability flag. Kích hoạt khi có supplier thật (story riêng).
- **Margin guard là requirement an toàn business chính** (AC2/AC3) — KHÔNG BAO GIỜ để user trả giá < retailPrice hoặc thấy QR wholesale gốc. Đây là lý do tồn tại của story (epic AC3/AC4).
- **Money path reuse** (NFR10): proxy_checkout trừ credit qua `storeCheckout` → `recordCreditTxn` (KHÔNG duplicate billing). Refund (nếu cần sau) qua `reverseTxn` (2.34 reconciliation).
- **Idempotency 2 lớp** (AC5, NFR7): `orders.idempotencyKey` (storeCheckout) + `supplierOrders` recheck theo orderId.
- **`supplierOrders` = tracking layer cho 2.33/2.34** — 2.33 (status sync) update `supplierStatus`; 2.34 (reconciliation) so `expectedMargin` vs actual.

### Phân biệt 2.32 vs 2.35 (tránh nhầm scope)

| | 2.35 reseller-apikey-code-inventory | 2.32 external-vendor-checkout |
|---|---|---|
| Nguồn hàng | Store GIỮ inventory (v98store key, viber.vn manual) qua `productCredentials` | Supplier sync catalog (2.30/2.31), store KHÔNG giữ hàng |
| Checkout | `storeCheckout` sẵn có (instant credential deliver) | `externalCheckout` wrapper (proxy_checkout → admin/sync đặt upstream) |
| product.source | có thể `local` hoặc external nhưng inventory nội bộ | `external_telegram_store` |
| Fulfillment | instant (credential có sẵn) | admin_fulfill (chờ đặt upstream) |

### Schema 2.32 thêm

```sql
-- supplierOrders (mới) — tracking đơn phía supplier cho external order
id TEXT PRIMARY KEY, orderId TEXT NOT NULL, supplierSourceId TEXT NOT NULL,
supplierProductId TEXT, paymentMode TEXT NOT NULL,
supplierOrderId TEXT, supplierInvoiceId TEXT, qrPayload TEXT,
supplierPrice REAL, retailPrice REAL, expectedMargin REAL, supplierStatus TEXT,
createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
-- Index: idx_supplier_order_order(orderId), idx_supplier_order_source(supplierSourceId)

-- supplierSources: thêm cột
paymentMode TEXT DEFAULT 'proxy_checkout'   -- default mode cho mọi product của nguồn

-- products: thêm cột (nullable, backward-compat)
paymentModeOverride TEXT   -- override per-product; null = dùng source.paymentMode
```

### Files sẽ chạm

- `src/lib/db/schema.js` — MODIFY (+supplierOrders, +supplierSources.paymentMode, +products.paymentModeOverride, bump SCHEMA_VERSION 14)
- `src/lib/db/migrations/012-supplier-orders.js` — NEW (version 12)
- `src/lib/db/migrations/index.js` — MODIFY (đăng ký m012)
- `src/lib/store/constants.js` — NEW (PAYMENT_MODES enum, E8) [hoặc thêm vào repo hiện có]
- `src/lib/db/repos/supplierOrdersRepo.js` — NEW
- `src/lib/db/repos/ordersRepo.js` — MODIFY (+`setOrderNoteSync` cho orphan-flag, KHÔNG đổi hàm cũ)
- `src/lib/db/index.js` — MODIFY (export supplierOrdersRepo)
- `src/lib/store/externalCheckout.js` — NEW (wrapper, KHÔNG sửa storeCheckout)
- `src/lib/telegram/router.js` — MODIFY (handleBuyExecute route external → externalCheckout, error messages)
- `src/app/api/store/supplier-orders/route.js` — NEW (admin GET, tối thiểu — có thể defer 2.34)
- `tests/unit/externalCheckout.test.js` — NEW
- `tests/unit/supplierOrdersRepo.test.js` — NEW
- `tests/unit/supplier-orders-migration.test.js` — NEW

### KHÔNG được chạm (scope guard)

- `src/lib/store/storeCheckout.js` — reuse as-is (QĐ8). proxy_checkout gọi qua, KHÔNG sửa.
- `src/sse/services/auth.js` / routing — 2.32 không liên quan routing.
- `src/lib/db/repos/creditLedgerRepo.js` — reuse recordCreditTxn/reverseTxn, KHÔNG sửa.
- Flow local product 2.26-2.28 + reseller 2.35 — chỉ thêm cột nullable + bảng mới, KHÔNG đổi hành vi.
- KHÔNG thêm `sendPhoto`/QR rendering (defer — vendor_commission chưa active).

### Testing standards

- Vitest từ `tests/`: `cd tests && npm test -- unit/<file>.test.js` (alias `@/`→`src/`, deps `/tmp/node_modules`)
- Setup giống `catalogSync-markup.test.js`/`storeCheckout.test.js`: temp `DATA_DIR`, `STORE_ENC_KEY`, `delete global._dbAdapter`, `vi.resetModules()`, `await getAdapter()`
- Mock supplier adapter qua registry (giống `catalogSync-markup.test.js` `vi.mock("@/lib/store/suppliers/index.js")`)

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-2.32] — AC gốc BDD (vendor_commission/proxy_checkout/separate_fee/disable, idempotency)
- [Source: _bmad-output/planning-artifacts/architecture-store.md#D2-D3-E1-E12] — order state machine, ledger reuse, idempotency pattern, E7 inline-transaction
- [Source: docs/stories/2-30-external-telegram-store-sources-catalog-sync.md#QĐ3] — adapter contract read-only (validate/fetchCatalog/normalizeProduct)
- [Source: docs/stories/2-31-external-product-markup-publishing.md#QĐ4-QĐ6] — priceCredits=retailPrice, getEffectivePrice, publish gate
- [Source: docs/stories/2-35-reseller-apikey-code-inventory.md] — reseller inventory model (phân biệt scope)
- [Source: src/lib/store/storeCheckout.js] — checkout transaction shape reuse (recordCreditTxn + insertOrderWithItems)
- [Source: src/lib/db/repos/ordersRepo.js] — ORDER_STATUSES, insertOrderWithItems, transitionOrderSync, getOrderByIdempotencyKeySync
- [Source: src/lib/store/suppliers/index.js] — adapter registry (capability detection điểm mở rộng)

## Code Review (2026-06-16)

_Adversarial 3-layer review trên commit `0952bb9`. Blind Hunter ✅ (13 findings), Acceptance Auditor ✅ (5 findings, all minor — impl faithful to spec), Edge Case Hunter ❌ (stalled/watchdog-killed sau khi đọc xong files — dimension này được reviewer verify trực tiếp trên code thay thế). Verification độc lập: 41 test mới pass (25 externalCheckout + 10 supplierOrdersRepo + 6 migration); migration chain apply sạch tới #12. Triage: 1 patch · 3 defer · 14 dismissed (false-positive/noise sau khi verify trên code thật)._

> ⚠️ **Lưu ý layer fail:** Edge Case Hunter subagent stalled (watchdog 600s) — reviewer đã đọc trực tiếp `externalCheckout.js`, `supplierOrdersRepo.js`, migration 012, `router.js` để bù coverage. Các finding dưới đã verify trên code, không chỉ dựa report agent.

**Patch (fixable, unambiguous):**

- [x] [Review][Patch][MINOR] Hardcode `'external_telegram_store'` thay vì dùng `EXTERNAL_SOURCE` (E8 enum drift) [`src/lib/db/repos/supplierOrdersRepo.js:167`, `src/lib/db/repos/supplierSourcesRepo.js:197`] — `findPaidExternalOrdersMissingSupplierOrder` SQL và `deleteSupplierSource` dùng string literal `'external_telegram_store'`. Mọi nơi khác (`externalCheckout.js`, `catalogSync.js`, `router.js`) import `EXTERNAL_SOURCE`. Nếu hằng số đổi tên/scope, 2 query này âm thầm sai (orphan-detection miss + cascade-delete miss). Fix: import `EXTERNAL_SOURCE` từ `catalogSync.js` và nội suy vào SQL (param hóa). Lưu ý SQL string không thể bind table/enum trực tiếp ở mọi vị trí — dùng param `WHERE p.source = ?` với `[EXTERNAL_SOURCE]`.

**Deferred (real nhưng ngoài scope 2.32 / cần story sau):**

- [x] [Review][Defer] `updateSupplierOrderStatus` COALESCE không cho clear field về null [`src/lib/db/repos/supplierOrdersRepo.js:108-111`] — `SET x = COALESCE(?, x)` giữ giá trị cũ khi truyền null → không thể null-out `supplierOrderId` khi supplier reject/cancel. Hiện KHÔNG có caller nào cần clear (2.32 chỉ insert + đọc). Defer: 2.33 (status sync) khi có cancel-flow sẽ cần explicit-clear semantics — giải quyết lúc đó.
- [x] [Review][Defer] `insertSupplierOrderSync` return tổng hợp từ `data` thay vì SELECT-after-insert [`src/lib/db/repos/supplierOrdersRepo.js:65`] — `rowToSupplierOrder({...data, id, ...})` synthesize return; cột hardcode null (supplierOrderId/Invoice/qrPayload/Status) khớp INSERT nên KHÔNG sai hiện tại. Fragile nếu schema thêm cột có DB default. Defer: robustness, không phải bug.
- [x] [Review][Defer] `handleBuyExecute` double product-load + product=null fall-through [`src/lib/telegram/router.js:188-189`] — load product 1 lần ở router (detect external), `externalCheckout` load lại; product null → `isExternal=false` → rơi xuống `storeCheckout` báo lỗi generic thay vì rõ ràng. Edge hiếm (product xoá giữa tap↔handler). Defer: minor UX, race window nhỏ.

**Dismissed (false-positive / noise — đã verify trên code):**

- "Orphan-recovery retry skip supplierOrders insert khi alreadyProcessed=true" (blind C-3) — SAI: `externalCheckout.js:156-178` chạy insert LUÔN (không gate theo `alreadyProcessed`), có recheck `getSupplierOrderByOrderIdSync` trong transaction. Retry bù được orphan row. Acceptance Auditor xác nhận đúng.
- "Nested transaction hazard / cross-connection race" (blind C-4) — noise: storeCheckout commit RỒI mới mở transaction phụ (sequential, không nest); `getAdapter()` trả singleton; window đã được orphan-recovery xử lý có chủ đích (QĐ5).
- "colExists PRAGMA SQL injection" (blind M) — SAI: SQLite KHÔNG bind được table-name trong PRAGMA; `table` hardcode (`"supplierSources"`/`"products"`), không user input. Giống dismiss ở review 2.31.
- "SCHEMA_VERSION=14 vs migration version=12 drift" (blind M) — SAI: decoupling có chủ đích từ 2.31 (track logical schema state, không phải migration count); grep xác nhận SCHEMA_VERSION KHÔNG dùng để gate migration.
- "supportsVendorOrder defined nhưng không gọi trong flow" (auditor) — noise: by-design, vendor_commission/separate_fee reject sớm bằng string compare; supportsVendorOrder là interface sẵn cho story sau (MVP mọi adapter=false → behavior giống hệt). Auditor tự xếp MINOR.
- Các noise khác: LIMIT 1 no ORDER BY (idempotency chỉ cần "any row"), updateSupplierOrderStatus no affected-rows-check (2.33 concern), listSupplierOrders lexicographic createdAt sort (ISO-8601 UTC nhất quán), resolvePaymentMode silent fallback (defensive), check-order disabled-before-margin (auditor xác nhận AC outcome đúng), test vi.resetModules placement (chạy đúng do ES hoisting), alreadyProcessed message disclose orderId (minor, order id không nhạy cảm), 4 ordersRepo export thừa (additive, vô hại).

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (BMAD Create Story workflow)

### Debug Log References

### Completion Notes List

### Agent Model Used

claude-sonnet-4-6 (BMAD Dev Story workflow)

### Debug Log References

- `createProduct` không accept external fields (source, supplierPrice, etc.) → test helpers dùng raw SQL UPDATE sau createProduct.
- Gate order sửa: payment-mode check (disabled) phải chạy TRƯỚC margin guard → disabled product không cần margin hợp lệ.
- `maskSource` trong `supplierSourcesRepo.js` thiếu `paymentMode` field → `resolvePaymentMode` luôn fallback về default → thêm mapping.

### Completion Notes List

- T1: `src/lib/store/constants.js` (PAYMENT_MODES enum), `schema.js` (SCHEMA_VERSION=14, supplierOrders table, paymentMode + paymentModeOverride columns), migration `012-supplier-orders.js` (idempotent ALTER + CREATE IF NOT EXISTS), registered in `migrations/index.js`.
- T2: `supplierOrdersRepo.js` — 6 functions: insertSupplierOrderSync, getSupplierOrderByOrderIdSync, getSupplierOrderByOrderId, updateSupplierOrderStatus, listSupplierOrders, findPaidExternalOrdersMissingSupplierOrder. Exported via `db/index.js`.
- T2b: `ordersRepo.js` thêm `setOrderNoteSync` — orphan-flag không đổi status.
- T3+T4: `externalCheckout.js` — resolvePaymentMode, supportsVendorOrder, ExternalCheckoutError, externalCheckout. Gate order: disabled → vendor_mode → margin → proxy_checkout. Orphan recovery via try/catch + setOrderNoteSync.
- T5: `router.js` — import externalCheckout + EXTERNAL_SOURCE, EXTERNAL_CHECKOUT_ERROR_MESSAGES map, handleBuyExecute route external qua externalCheckout.
- T6: Deferred sang 2.34 (không block AC).
- T7: 41 tests mới (25 externalCheckout + 10 supplierOrdersRepo + 6 migration). Full suite: 1562 pass / 3 pre-existing fail / 58 skip.
- `supplierSourcesRepo.maskSource` thêm `paymentMode` field để resolvePaymentMode hoạt động đúng.

### File List

- `src/lib/store/constants.js` — NEW
- `src/lib/db/schema.js` — MODIFIED (SCHEMA_VERSION=14, supplierOrders table, paymentMode + paymentModeOverride columns)
- `src/lib/db/migrations/012-supplier-orders.js` — NEW
- `src/lib/db/migrations/index.js` — MODIFIED (registered m012)
- `src/lib/db/repos/supplierOrdersRepo.js` — NEW
- `src/lib/db/repos/ordersRepo.js` — MODIFIED (setOrderNoteSync added)
- `src/lib/db/repos/supplierSourcesRepo.js` — MODIFIED (maskSource thêm paymentMode field)
- `src/lib/db/index.js` — MODIFIED (export supplierOrdersRepo + setOrderNoteSync)
- `src/lib/store/externalCheckout.js` — NEW
- `src/lib/telegram/router.js` — MODIFIED (import externalCheckout, EXTERNAL_CHECKOUT_ERROR_MESSAGES, handleBuyExecute routing)
- `tests/unit/externalCheckout.test.js` — NEW (25 tests)
- `tests/unit/supplierOrdersRepo.test.js` — NEW (10 tests)
- `tests/unit/supplier-orders-migration.test.js` — NEW (6 tests)

## Change Log

- 2026-06-16: Story 2.32 implemented — external vendor checkout + supplier QR handoff. Migration 012 (supplierOrders table, paymentMode columns), externalCheckout wrapper (proxy_checkout path, margin guard, payment-mode gate, orphan recovery), bot UI routing, 41 new tests. 1562 tests pass.
