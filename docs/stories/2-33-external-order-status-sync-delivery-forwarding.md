---
baseline_commit: 6b9f61b
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture-store.md
  - docs/stories/2-30-external-telegram-store-sources-catalog-sync.md
  - docs/stories/2-31-external-product-markup-publishing.md
  - docs/stories/2-32-external-vendor-checkout-supplier-qr-handoff.md
  - src/lib/db/schema.js
  - src/lib/db/repos/ordersRepo.js
  - src/lib/db/repos/supplierOrdersRepo.js
  - src/lib/store/catalogSync.js
  - src/lib/store/adminFulfill.js
  - src/lib/telegram/botClient.js
  - src/app/api/store/suppliers/webhook/[id]/route.js
---

# Story 2.33: External Order Status Sync & Delivery Forwarding

Status: done

## Story

As a buyer,
I want nhận cập nhật trạng thái và sản phẩm từ supplier thông qua bot store của bạn,
so that tôi không cần thao tác trực tiếp với store nguồn sau khi đã thanh toán — bot tự cập nhật đơn và chuyển tiếp hàng cho tôi.

## Bối cảnh và quyết định architecture

> **Story này là bước tiếp theo của nhánh external-store sau 2.30 (source+sync), 2.31 (markup+publish), 2.32 (vendor checkout + `supplierOrders` tracking).** 2.33 = **đồng bộ trạng thái đơn supplier + chuyển tiếp delivery cho buyer**. KHÔNG đụng routing/billing-core. Reuse `supplierOrders` (2.32), state machine `canTransition` (2.26), `reverseTxn` (refund), `sendMessage` (bot).

### ⚠️ Reality check — đọc TRƯỚC khi implement (verified tại baseline 6b9f61b)

Ba sự thật về codebase định hình toàn bộ scope. Dev PHẢI hiểu trước khi code:

1. **Supplier adapter hiện 100% READ-ONLY catalog-consumer.** 4 adapter (`supplier_api`/`channel_feed`/`polling_feed`/`webhook`) chỉ có `validate`/`fetchCatalog`/`normalizeProduct`. **KHÔNG có** `getOrderStatus`, `fetchDelivery`, `pollOrders` — không cơ chế đọc trạng thái đơn hay delivery feed phía supplier. [Source: src/lib/store/suppliers/index.js]

2. **`applyWebhookEvent` (catalogSync.js:181) chỉ xử lý PRODUCT catalog event**, KHÔNG phải order status. Nó normalize qua `adapter.normalizeProduct` rồi `upsertExternalProduct`. Order-status event là payload KHÁC HẲN (supplierOrderId + status + delivery payload) → KHÔNG thể nhồi vào `applyWebhookEvent`. Cần endpoint + handler riêng.

3. **`botClient.js` chỉ có `sendMessage` (text/HTML)** — KHÔNG có `sendPhoto`/`sendDocument`. Forward delivery dạng text/credential khả thi; forward file/ảnh = DEFER (cần sendDocument).

**Hệ quả (quyết định scope — best practice, YAGNI + match reality, nhất quán 2.32):** Vì không supplier MVP nào thật sự push order-status hay giao hàng qua channel ta đọc được, 2.33 build **khung capability-gated** + path khả thi:

- **Order-status webhook endpoint (NEW)** — nhận supplier push `{supplierOrderId, status, deliveryPayload?}`, verify secret (reuse `secretMatches`), map → internal order status. Path khả thi.
- **Status mapping + terminal-guard** — reuse `canTransition` (đã chặn downgrade terminal sẵn). AC1/AC2/AC5.
- **Delivery forwarding (text/credential)** — forward payload qua `sendMessage` cho buyer private chat + ghi audit (KHÔNG log payload). AC3.
- **Delivery audit table (NEW)** — append-only metadata trail (KHÔNG payload). AC3.
- **Polling status path** — capability `supportsOrderStatus()` default `false` → stub/defer (không adapter nào hỗ trợ). AC2 alt.
- **Unsupported delivery (private-chat không đọc được)** — KHÔNG claim auto-forward; giữ `admin_fulfill` manual. AC4.
- **Notification + refund guidance** — bot báo user theo terminal status; refund qua `reverseTxn` (admin-triggered, link 2.34). AC5.

### Hiện trạng code (verified tại baseline 6b9f61b)

- **`supplierOrders` table** (2.32, `schema.js`): `id, orderId, supplierSourceId, supplierProductId, paymentMode, supplierOrderId, supplierInvoiceId, qrPayload, supplierPrice, retailPrice, expectedMargin, supplierStatus, createdAt, updatedAt`. **`supplierStatus`** + **`updateSupplierOrderStatus(id, {supplierOrderId, supplierInvoiceId, qrPayload, supplierStatus})`** đã sẵn — 2.33 ghi raw supplier status vào đây.
- **`supplierOrdersRepo.js`** (2.32): `insertSupplierOrderSync`, `getSupplierOrderByOrderIdSync`, `getSupplierOrderByOrderId`, `updateSupplierOrderStatus`, `listSupplierOrders`, `findPaidExternalOrdersMissingSupplierOrder`. ⚠️ **`getSupplierOrderBySupplierOrderId` CHƯA có** — 2.33 cần lookup theo `supplierOrderId` (id phía supplier) để map webhook event về internal order. Thêm.
- **`ordersRepo.js` state machine** (`ALLOWED_TRANSITIONS`): `pending→[paid,cancelled,failed]`, `paid→[fulfilled,cancelled,failed,refunded]`, `fulfilled→[refunded]`, `cancelled|failed|refunded→[]` (terminal). `canTransition(from,to)` đã chặn downgrade. `transitionOrderSync(adapter, orderId, toStatus, {note})` (sync, trong transaction), `transitionOrder(orderId, toStatus, {note})` (async). `ORDER_STATUSES=[pending,paid,fulfilled,cancelled,failed,refunded]`.
- **`adminFulfill.js`** (2.28): `fulfillOrder(orderId, {credentialId, note})`, `cancelOrder(orderId, {note})`, `FulfillError`. Pattern: load order → assert status → transaction(transition + setFulfilledAt) → post-commit `sendMessage` buyer. 2.33 mirror pattern này cho supplier-driven fulfill.
- **`completeDeliverySync`** (2.27): credential reserved→delivered. KHÔNG dùng cho external (external delivery là payload supplier push, không phải pre-stocked credential).
- **Webhook route** (`/api/store/suppliers/webhook/[id]/route.js`, 2.30): `secretMatches(provided, expected)` (SHA-256 + `timingSafeEqual`, anti length-leak), uniform 401, `syncMode==='webhook'` guard, read secret từ `getSupplierSourceWithAuth().auth.webhookSecret`. 2.33 endpoint reuse `secretMatches` + cùng pattern verify.
- **`reverseTxn(originalId, note, db?)`** (creditLedgerRepo, BP-1 immutable, idempotent `reversal:${originalId}`) — refund. E7 dual-mode.
- **`getUserByTelegramId` / orders.userId** — buyer lookup để `sendMessage`. `getOrderById`/`getOrderWithItems` có sẵn.
- **`SCHEMA_VERSION = 14`**. Migration mới nhất `012-supplier-orders.js` (version 12). Slot 013 trống.

### Quyết định architecture (chốt cho story này)

- **QĐ1 — Order-status webhook endpoint (NEW, TÁCH khỏi product catalog webhook)**: `POST /api/store/suppliers/order-webhook/[id]/route.js`. Verify secret reuse `secretMatches` + `syncMode==='webhook'` guard + uniform 401 (giống product webhook — chống source-existence oracle). Payload: `{ supplierOrderId, status, delivery? }` (`delivery` optional = `{ type: 'text'|'credential', payload }`). KHÔNG nhồi vào `applyWebhookEvent` (đó là product catalog). Handler gọi `applyOrderStatusEvent(sourceId, event)`.

- **QĐ2 — `applyOrderStatusEvent(sourceId, event)` trong `src/lib/store/orderStatusSync.js` (NEW)**:
  - Lookup `supplierOrders` theo `event.supplierOrderId` (qua `getSupplierOrderBySupplierOrderId` — thêm ở T1) → tìm internal `orderId`. Không thấy → `{ ok:false, error:'supplier order not found' }` (idempotent-safe, không tạo gì).
  - Verify `supplierOrders.supplierSourceId === sourceId` (event phải thuộc đúng source đã verify secret — chống cross-source spoof).
  - Map `event.status` (supplier) → internal status (QĐ3). Ghi `supplierStatus` raw qua `updateSupplierOrderStatus` (audit, luôn ghi kể cả khi internal status không đổi).
  - Nếu internal transition hợp lệ (`canTransition`) → `transitionOrderSync` trong transaction. Nếu KHÔNG hợp lệ (terminal-guard chặn) → KHÔNG đổi, log, return `{ ok:true, skipped:'terminal' }` (AC2/AC5 no-downgrade).
  - Nếu `event.delivery` có → forward (QĐ4) + audit.

- **QĐ3 — Status mapping (supplier → internal)** (E8 enum, `src/lib/store/constants.js` mở rộng):
  ```
  SUPPLIER_ORDER_STATUS_MAP = {
    paid:      null,        // order đã 'paid' từ checkout proxy_checkout (2.32) — no-op, chỉ ghi supplierStatus
    fulfilled: 'fulfilled', // chỉ set khi delivery đã forward thành công (hoặc admin xác nhận) — xem QĐ4
    expired:   'failed',    // supplier hết hạn → internal failed
    cancelled: 'cancelled',
    failed:    'failed',
  }
  ```
  - `canTransition` quyết định cuối: vd order đã `fulfilled` → supplier gửi `cancelled` → `canTransition('fulfilled','cancelled')=false` → skip (terminal-guard, AC5). Order đã `failed` → supplier gửi `fulfilled` → `canTransition('failed','fulfilled')=false` → skip (no resurrect terminal).
  - `paid` từ supplier KHÔNG transition (order proxy_checkout đã paid lúc checkout); chỉ cập nhật `supplierStatus`.
  - ⚠️ **`fulfilled` là delivery-gated, KHÔNG transition vô điều kiện** (case quan trọng): map `fulfilled→'fulfilled'` CHỈ áp dụng KHI có `event.delivery` forward được (text/credential) thành công (QĐ4). Nếu supplier gửi `status='fulfilled'` NHƯNG **không kèm delivery** (hoặc delivery unsupported) → KHÔNG set internal `fulfilled` (bot chưa giao gì cho buyer → không được claim đã hoàn tất). Order GIỮ `paid`, ghi audit `status='unsupported'`, notify admin xử lý thủ công (giống AC4). `supplierStatus='fulfilled'` vẫn được ghi (audit raw). Lý do: `fulfilled` nghĩa là buyer ĐÃ nhận hàng qua bot — chỉ đúng khi delivery thực sự forward. Tránh đánh dấu hoàn tất khống.

- **QĐ4 — Delivery forwarding (AC3/AC4)** trong `orderStatusSync.js`:
  - `event.delivery.type ∈ {text, credential}` + `payload` string → forward `sendMessage(buyer.telegramId, payload)` (credential bọc `<pre>`). Forward thành công → set order `fulfilled` (nếu `canTransition('paid','fulfilled')`), `setFulfilledAt`, ghi audit `status='forwarded'`.
  - `event.delivery.type ∈ {file, message, image}` hoặc không có payload đọc được → **KHÔNG claim auto-forward** (botClient chưa có sendDocument). Ghi audit `status='unsupported'`, order GIỮ `paid` (admin_fulfill manual, AC4), notify admin/user "cần xử lý thủ công".
  - **Forward TÁCH transaction với status update**: status transition trong `db.transaction()` (atomic); `sendMessage` post-commit (best-effort, giống 2.28 adminFulfill) — gửi fail KHÔNG rollback fulfilled, nhưng ghi audit `status='forward_failed'` + notify fallback (user xem /orders).
  - **Audit KHÔNG log payload** (NFR8/D6): chỉ ghi `{supplierOrderId, orderId, deliveryType, status, forwardedAt}`. Payload buyer's — forward ngay, KHÔNG lưu DB.

- **QĐ5 — `supplierDeliveries` audit table (NEW, append-only)**:
  ```
  id TEXT PRIMARY KEY, supplierOrderId TEXT NOT NULL, orderId TEXT NOT NULL,
  deliveryType TEXT,           -- text|credential|file|message|image|unknown
  status TEXT NOT NULL,        -- forwarded|forward_failed|unsupported
  note TEXT,                   -- optional, KHÔNG chứa payload
  createdAt TEXT NOT NULL
  -- Index: idx_supplier_delivery_order(orderId)
  -- KHÔNG có cột payload — audit metadata only (NFR8/D6/AC3)
  ```

- **QĐ6 — Polling status path (AC2)**: capability `supportsOrderStatus(supplierAdapter)` = `typeof supplierAdapter.getOrderStatus === 'function'` (default `false` mọi adapter MVP). `pollOrderStatuses()` driver chỉ chạy cho source có capability — MVP rỗng → no-op. KHÔNG build `getOrderStatus` thật (speculative, YAGNI — như 2.32 vendor_commission defer). Interface sẵn cho story sau khi có supplier thật.

- **QĐ7 — User notification (AC1/AC5)**: sau terminal transition, bot `sendMessage` buyer:
  - `fulfilled` (delivery forwarded) → payload đã gửi + "✅ Đơn đã hoàn tất".
  - `failed`/`cancelled` (từ expired/failed/cancelled) → "❌ Đơn không thành công. Liên hệ /support để được hỗ trợ/hoàn tiền." KHÔNG auto-refund (admin quyết, 2.34 reconciliation). Note order để admin xử refund qua `reverseTxn`.
  - Mọi message gửi best-effort post-commit (không rollback).

- **QĐ8 — Idempotency (AC supplier retry)**: supplier webhook retry cùng `supplierOrderId` + `status` → `applyOrderStatusEvent` idempotent: `canTransition` chặn re-transition (order đã ở status đích → `canTransition(X,X)=false` vì không có self-edge) → skip. Delivery forward: nếu `supplierDeliveries` đã có row `status='forwarded'` cho `supplierOrderId` → KHÔNG forward lại (chống gửi payload 2 lần). Check trước forward.

- **QĐ9 — KHÔNG đụng routing/billing-core/storeCheckout**: 2.33 chỉ thêm status-sync + delivery-forward + audit. Reuse `transitionOrderSync`/`reverseTxn`/`sendMessage`. KHÔNG sửa `storeCheckout.js`, `getProviderCredentials`, `recordCreditTxn`. Auto-refund logic = 2.34.

## Acceptance Criteria

### AC1 — Webhook order status → cập nhật internal order + notify user
**Given** supplier gửi webhook order status (`paid`/`fulfilled`/`expired`/`cancelled`/`failed`) qua endpoint được verify secret
**When** event xử lý
**Then** internal order cập nhật trạng thái tương ứng theo `SUPPLIER_ORDER_STATUS_MAP` + `canTransition` (paid=no-op chỉ ghi supplierStatus; **fulfilled→fulfilled CHỈ KHI delivery forward thành công** — không có delivery → giữ paid + admin manual, xem QĐ3/QĐ4; expired/failed→failed; cancelled→cancelled)
**And** `supplierOrders.supplierStatus` ghi raw status (audit)
**And** user nhận Telegram notification phù hợp (QĐ7).

### AC2 — Polling status path (không downgrade terminal)
**Given** supplier KHÔNG có webhook nhưng có status API/feed
**When** polling chạy
**Then** hệ thống cập nhật theo response mới nhất — **NHƯNG** MVP: không adapter nào có `getOrderStatus` (`supportsOrderStatus()=false`) → polling no-op, stub sẵn interface (defer tới khi có supplier thật)
**And** terminal status đã chốt KHÔNG bị downgrade (reuse `canTransition`: `fulfilled`/`failed`/`cancelled`/`refunded` không có outgoing edge phù hợp → mọi event sau bị skip).

### AC3 — Delivery forwarding (text/credential) + audit không log payload
**Given** supplier giao text/credential payload qua webhook delivery field mà bot đọc được
**When** delivery xác thực thuộc supplier order của buyer (`supplierOrders.orderId` → `orders.userId`)
**Then** bot forward payload cho buyer trong private chat (`sendMessage`, credential bọc `<pre>`)
**And** ghi `supplierDeliveries` audit (`deliveryType/status/forwardedAt`) **KHÔNG log payload** (NFR8)
**And** order → `fulfilled` + `setFulfilledAt` nếu forward thành công.

### AC4 — Unsupported delivery → KHÔNG claim auto-forward
**Given** supplier chỉ giao vào private chat giữa supplier bot và account khác mà system KHÔNG đọc được (hoặc delivery type file/image — botClient chưa hỗ trợ)
**When** order chờ delivery forwarding
**Then** hệ thống KHÔNG claim auto-forward, KHÔNG set fulfilled
**And** ghi audit `status='unsupported'`, order giữ `paid` (admin_fulfill manual)
**And** notify admin/user cần xử lý thủ công.

### AC5 — Terminal failure → KHÔNG fulfilled + notify support/refund
**Given** supplier order `expired`/`failed`/`cancelled`
**When** trạng thái được sync
**Then** internal order KHÔNG được marked `fulfilled` (map → `failed`/`cancelled`)
**And** bot thông báo user kèm hướng dẫn /support
**And** refund KHÔNG tự động (admin quyết qua `reverseTxn`, link 2.34); order được note để reconciliation.

### AC6 — Backward-compat: local product + internal flow KHÔNG đổi
**Given** toàn bộ thay đổi 2.33
**When** local order (2.26-2.28) hoặc external order proxy_checkout (2.32) chạy
**Then** state machine + `storeCheckout` + `recordCreditTxn` hành vi KHÔNG đổi (chỉ THÊM endpoint + `orderStatusSync.js` + `supplierDeliveries` table + 1 repo fn lookup)
**And** full unit suite pass.

## Tasks / Subtasks

- [x] **T1 — Schema: `supplierDeliveries` table + migration + repo lookup** (AC3, AC6)
  - [x] Thêm bảng `supplierDeliveries` vào `TABLES` (schema.js) camelCase (QĐ5) + index `idx_supplier_delivery_order(orderId)`. KHÔNG có cột payload.
  - [x] Bump `SCHEMA_VERSION = 15`.
  - [x] Tạo `src/lib/db/migrations/013-supplier-deliveries.js` (**version 13** — slot 012 đã bị `012-supplier-orders.js` chiếm): guard `tableExists`, `CREATE TABLE IF NOT EXISTS supplierDeliveries`. Đăng ký `migrations/index.js` (import `m013`, append).
  - [x] `supplierOrdersRepo.js`: thêm `getSupplierOrderBySupplierOrderId(supplierOrderId)` (async) — lookup theo id phía supplier để map webhook event → internal order (QĐ2). Export qua `db/index.js`.

- [x] **T2 — `supplierDeliveriesRepo.js`** (AC3) — `src/lib/db/repos/supplierDeliveriesRepo.js`
  - [x] `insertDeliverySync(adapter, {supplierOrderId, orderId, deliveryType, status, note})` — sync, trong caller transaction. KHÔNG nhận/lưu payload.
  - [x] `hasForwardedDeliverySync(adapter, supplierOrderId)` — sync, check đã có row `status='forwarded'` cho supplierOrderId (idempotency QĐ8).
  - [x] `listDeliveriesByOrder(orderId)` — async (admin view 2.34).
  - [x] Export qua `db/index.js`.

- [x] **T3 — Status mapping enum + capability detection** (AC1, AC2, QĐ3/QĐ6) — `src/lib/store/constants.js` (mở rộng)
  - [x] `SUPPLIER_ORDER_STATUSES = ['paid','fulfilled','expired','cancelled','failed']` (raw supplier statuses, E8).
  - [x] `SUPPLIER_ORDER_STATUS_MAP` (QĐ3): paid→null, fulfilled→'fulfilled', expired→'failed', cancelled→'cancelled', failed→'failed'.
  - [x] `supportsOrderStatus(supplierAdapter)` = `typeof supplierAdapter?.getOrderStatus === 'function'` (default false; KHÔNG implement getOrderStatus thật — defer).

- [x] **T4 — `orderStatusSync.js`** (AC1-AC5, QĐ2/QĐ4/QĐ7) — `src/lib/store/orderStatusSync.js` (NEW)
  - [x] `class OrderStatusError(code, message)` — codes: `SUPPLIER_ORDER_NOT_FOUND | SOURCE_MISMATCH | INVALID_STATUS`.
  - [x] `applyOrderStatusEvent(sourceId, event)`: lookup → source verify → status validate → supplierStatus audit → map → canTransition → transition in txn → forwardDelivery if delivery → notify post-commit.
  - [x] `forwardDeliverySync(adapter, ...)` (QĐ4): idempotency check → text/credential → transition fulfilled + setFulfilledAt + audit `forwarded`; unsupported type → audit `unsupported`, order giữ paid.
  - [x] User notification (QĐ7): post-commit best-effort `sendMessage` theo terminal status.

- [x] **T5 — Order-status webhook endpoint** (AC1) — `src/app/api/store/suppliers/order-webhook/[id]/route.js` (NEW)
  - [x] POST: verify secret + syncMode==='webhook' + uniform 401. Parse body → `{supplierOrderId, status, delivery?}`; 400 khi thiếu field. `applyOrderStatusEvent` → 422/200/500.

- [x] **T6 — Polling driver stub** (AC2) — `orderStatusSync.js`
  - [x] `pollOrderStatuses()` — no-op stub, capability-gated interface sẵn cho future.

- [x] **T7 — Tests** (AC1-AC6) — `tests/unit/`
  - [x] `orderStatusSync.test.js` (mới, 19 tests): AC1 map paid/fulfilled/expired/cancelled/failed; AC2 terminal-guard; error cases; AC3 text/credential forward + idempotency; AC4 unsupported + fulfilled-without-delivery; AC5 terminal failure + notify; AC6 regression.
  - [x] `supplierDeliveriesRepo.test.js` (mới, 10 tests): insert/has-forwarded/list, KHÔNG có cột payload.
  - [x] `supplier-deliveries-migration.test.js` (mới, 5 tests): migration 013 tạo table, idempotent, backward-compat.
  - [x] **Regression (AC6)**: full suite 1607/1668 pass; 3 failures pre-existing ERR_DLOPEN_FAILED (unrelated native binary).

## Dev Notes

### Ràng buộc bắt buộc

- **KHÔNG nhồi order-status vào `applyWebhookEvent`** — đó là product catalog handler (normalizeProduct → upsertExternalProduct). Order status là domain khác → `applyOrderStatusEvent` + endpoint riêng (QĐ1/QĐ2).
- **Terminal-guard = reuse `canTransition`, KHÔNG viết logic mới** — state machine `ALLOWED_TRANSITIONS` đã chặn downgrade (`fulfilled`/`failed`/`cancelled`/`refunded` terminal). Map status rồi để `canTransition` quyết; skip nếu false (AC2/AC5). KHÔNG hardcode "if terminal then skip".
- **Delivery audit KHÔNG log payload** (NFR8/D6/AC3) — `supplierDeliveries` chỉ metadata; payload forward ngay qua sendMessage, KHÔNG lưu DB. Grep đảm bảo không có cột/log payload.
- **Forward TÁCH transaction với status update** — transition trong `db.transaction()` (atomic); `sendMessage` post-commit best-effort (giống adminFulfill 2.28). Gửi fail KHÔNG rollback fulfilled → audit `forward_failed` + fallback notify (user xem /orders). Tránh giữ transaction mở qua network call.
- **Idempotency 2 lớp** (QĐ8): `canTransition` chặn re-transition (status đích = no self-edge); `hasForwardedDeliverySync` chặn gửi payload 2 lần.
- **KHÔNG auto-refund** — terminal failure chỉ notify + note; refund là admin action (`reverseTxn`) hoặc 2.34 reconciliation. KHÔNG gọi reverseTxn tự động trong 2.33.
- **KHÔNG build `getOrderStatus`/polling thật, KHÔNG thêm sendDocument** — speculative, không supplier MVP nào cần (YAGNI, nhất quán 2.32 vendor_commission defer). Capability flag + stub sẵn.
- **KHÔNG đụng routing/storeCheckout/recordCreditTxn** (QĐ9, scope guard). Nếu thấy cần sửa → DỪNG, lệch scope.

### Phân biệt 2.33 vs 2.32 vs 2.27

| | 2.27 (internal fulfillment) | 2.32 (vendor checkout) | 2.33 (status sync + delivery) |
|---|---|---|---|
| Delivery nguồn | `productCredentials` pre-stocked (reserved→delivered) | n/a (chỉ tạo order + supplierOrders) | supplier push payload qua webhook delivery field |
| Status driver | admin manual (adminFulfill) | n/a | supplier webhook (+ polling stub) |
| Fulfill trigger | admin/instant | n/a (order ở paid chờ) | supplier status event + delivery forward |

### Schema 2.33 thêm

```sql
-- supplierDeliveries (mới) — audit metadata, KHÔNG payload (NFR8)
id TEXT PRIMARY KEY, supplierOrderId TEXT NOT NULL, orderId TEXT NOT NULL,
deliveryType TEXT, status TEXT NOT NULL, note TEXT, createdAt TEXT NOT NULL
-- Index: idx_supplier_delivery_order(orderId)
```

### Files sẽ chạm

- `src/lib/db/schema.js` — MODIFY (+supplierDeliveries, bump SCHEMA_VERSION 15)
- `src/lib/db/migrations/013-supplier-deliveries.js` — NEW (version 13)
- `src/lib/db/migrations/index.js` — MODIFY (đăng ký m013)
- `src/lib/store/constants.js` — MODIFY (+SUPPLIER_ORDER_STATUSES, +SUPPLIER_ORDER_STATUS_MAP)
- `src/lib/db/repos/supplierOrdersRepo.js` — MODIFY (+getSupplierOrderBySupplierOrderId)
- `src/lib/db/repos/supplierDeliveriesRepo.js` — NEW
- `src/lib/db/index.js` — MODIFY (export mới)
- `src/lib/store/orderStatusSync.js` — NEW (applyOrderStatusEvent, forwardDelivery, pollOrderStatuses stub)
- `src/app/api/store/suppliers/order-webhook/[id]/route.js` — NEW
- `tests/unit/orderStatusSync.test.js` — NEW
- `tests/unit/supplierDeliveriesRepo.test.js` — NEW
- `tests/unit/supplier-deliveries-migration.test.js` — NEW

### KHÔNG được chạm (scope guard)

- `src/lib/store/storeCheckout.js`, `src/lib/store/externalCheckout.js` — checkout là 2.32, KHÔNG sửa.
- `src/sse/services/auth.js` / routing — không liên quan.
- `src/lib/db/repos/creditLedgerRepo.js` — reuse reverseTxn (admin path), KHÔNG sửa; KHÔNG auto-refund.
- `applyWebhookEvent` / `catalogSync.js` product path — order status là handler riêng, KHÔNG đụng product sync.

### Testing standards

- Vitest từ `tests/`: `cd tests && npm test -- unit/<file>.test.js` (alias `@/`→`src/`, deps `/tmp/node_modules`; nếu flap dùng `node_modules/.bin/vitest` local).
- Setup giống `catalogSync-markup.test.js`/`externalCheckout.test.js`: temp `DATA_DIR`, `STORE_ENC_KEY`, `delete global._dbAdapter`, `vi.resetModules()`, `await getAdapter()`.
- Mock `sendMessage` (`vi.mock` botClient) để assert forward gọi đúng + KHÔNG leak payload vào audit.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-2.33] — AC gốc BDD (webhook/polling status, delivery forward, unsupported, terminal failure)
- [Source: _bmad-output/planning-artifacts/architecture-store.md#D2-D6-E1-E12] — order state machine, credential security (NFR8), idempotency, fail-soft webhook
- [Source: docs/stories/2-32-external-vendor-checkout-supplier-qr-handoff.md#QĐ3] — supplierOrders table + updateSupplierOrderStatus reuse
- [Source: docs/stories/2-30-external-telegram-store-sources-catalog-sync.md] — secretMatches webhook verify pattern + uniform 401
- [Source: src/lib/db/repos/ordersRepo.js] — canTransition/ALLOWED_TRANSITIONS terminal-guard, transitionOrderSync
- [Source: src/lib/store/adminFulfill.js] — fulfill pattern (transaction transition + post-commit sendMessage)
- [Source: src/app/api/store/suppliers/webhook/[id]/route.js] — webhook secret verify reuse

## Code Review (2026-06-16)

_Adversarial 3-layer review trên working-tree (uncommitted). Blind Hunter (19 findings), Acceptance Auditor (5), Edge Case Hunter (7 — hit transient 499, resumed). Tất cả finding verify trực tiếp trên code. Verification độc lập: 34 test mới pass; migration chain apply sạch tới #13; full suite 1688 pass / 0 fail. Triage: 3 patch · 4 defer · ~17 dismissed (gồm 1 "CRITICAL" SCHEMA_VERSION được 2 agent báo nhưng là false-positive)._

**Patch (fixable, unambiguous):**

- [x] [Review][Patch][MAJOR] `forwardDeliverySync` ghi audit `forwarded` + gửi payload kể cả khi `canTransition` chặn (order đã terminal) [`src/lib/store/orderStatusSync.js:97-111`] — khi delivery hợp lệ nhưng `canTransition(order.status,'fulfilled')=false` (vd order đã `cancelled`/`failed`), code vẫn `insertDeliverySync(status='forwarded')` + return `forwarded:true` → caller gửi payload cho buyer cho một đơn KHÔNG fulfill được. Audit sai (claim forwarded nhưng order ở terminal khác) + buyer nhận hàng cho đơn đã hủy. Fix: nếu `!transitioned` (canTransition false) → ghi `status='unsupported'` (hoặc `forward_failed`) + KHÔNG return forwarded:true cho path gửi payload; hoặc skip toàn bộ forward khi order đã terminal (giống AC5 no-resurrect). Verify trên code.
- [x] [Review][Patch][MAJOR] Path `forward_failed` (QĐ4 spec) hoàn toàn vắng mặt [`src/lib/store/orderStatusSync.js:192-200`] — QĐ4: "gửi fail KHÔNG rollback fulfilled, NHƯNG ghi audit `status='forward_failed'` + notify fallback". Impl set fulfilled + audit `forwarded` trong txn, rồi `notifyBuyer(...).catch(()=>{})` post-commit nuốt lỗi im lặng — KHÔNG ghi `forward_failed`, KHÔNG fallback notify. `forward_failed` chỉ tồn tại trong comment repo, không code path nào insert. Hệ quả: delivery gửi fail không phân biệt được với thành công trong audit. Fix: `notifyBuyer` trả `false` (đã có) → ghi audit `forward_failed` + fallback message "xem /orders". Thêm test (T7 thiếu case này).
- [x] [Review][Patch][MAJOR] HTML-injection: supplier payload nội suy thô vào `<pre>${payload}</pre>` (parse_mode HTML) [`src/lib/store/orderStatusSync.js:194-196`] — `sendMessage` dùng `parse_mode:'HTML'` (botClient.js:54). Payload từ supplier (UNTRUSTED, khác credential admin-loaded 2.27/2.28) chứa `<`/`>`/`</pre>` → vỡ format hoặc inject HTML (vd `</pre><b>phishing link</b>` → buyer thấy message giả mạo trong kênh tin cậy). Fix: `escapeHtml(payload)` (đã có `src/lib/email/escapeHtml.js`) trước khi nội suy. ⚠️ Cân nhắc fix luôn 2.27/2.28 (`router.js:227`, `adminFulfill.js:48`) nhưng đó là admin-loaded ít rủi ро hơn — tối thiểu PHẢI escape ở 2.33 vì nguồn supplier.

**Deferred (real nhưng ngoài scope / cần story sau):**

- [x] [Review][Defer] `payload` return từ `forwardDeliverySync` → latent credential-leak surface [`src/lib/store/orderStatusSync.js:111`] — payload chảy qua return value + caller scope; hiện KHÔNG bị log (NFR8 audit row không chứa payload — verified). Risk chỉ là nếu tương lai thêm debug-log result object. Defer: refactor consume payload trong closure; không phải leak hiện tại.
- [x] [Review][Defer] `getSupplierOrderBySupplierOrderId` LIMIT 1 không ORDER BY + không UNIQUE constraint trên `supplierOrderId` [`src/lib/db/repos/supplierOrdersRepo.js:95`] — supplier reuse supplierOrderId (rất hiếm) → non-deterministic row. better-sqlite3 single-writer nên không race; nhưng nếu dup tồn tại → transition nhầm order. Defer: thêm `ORDER BY createdAt DESC` hoặc UNIQUE index — cân nhắc ở 2.34 reconciliation (cùng lúc xử supplierOrders integrity).
- [x] [Review][Defer] `updateSupplierOrderStatus` ghi `supplierStatus` TRƯỚC khi load internal order (line 144 vs 147) [`src/lib/store/orderStatusSync.js:144`] — nếu internal order bị hard-delete → supplierStatus ghi rồi nhưng return error, audit lệch. Edge cực hiếm (orders không hard-delete trong flow thường). Defer: gate write sau order-load hoặc wrap txn; audit-only, không ảnh hưởng user state.
- [x] [Review][Defer] `notifyManual`/`notifyBuyer` fire-and-forget nuốt lỗi không log [`src/lib/store/orderStatusSync.js:174`] — `.catch(()=>{})` ở line 174 (notifyManual path) không log; line 197/199/226 cũng vậy. Best-effort post-commit là đúng QĐ7, nhưng silent làm khó debug ops. Defer: thêm `.catch(e=>console.error(...))` (notifyBuyer nội bộ đã log; chỉ các call-site ngoài thiếu). Minor ops.

**Dismissed (false-positive / noise — đã verify trên code):**

- **`SCHEMA_VERSION=15` vs migration version=13 "CRITICAL startup failure"** (blind + edge, CẢ HAI báo) — SAI HOÀN TOÀN: `SCHEMA_VERSION` KHÔNG được consume ở đâu cả (grep confirm chỉ có dòng định nghĩa). Migration gate dùng `latestVersion()` (=13) ở `migrate.js:70,73`, KHÔNG dùng SCHEMA_VERSION. Offset +2 đã tồn tại từ 2.31 (13 vs 11) và 2.32 (14 vs 12). Không có startup check nào so SCHEMA_VERSION===latestVersion. Zero impact.
- "`forwardResult` undefined nếu transaction throw → TypeError" (blind + edge) — noise: nếu `insertDeliverySync` throw, txn rollback (đúng), TypeError propagate tới route catch → 500, supplier retry. Audit-gap on DB-error là edge chấp nhận được; không phải bug logic. (Path chính không throw.)
- "`updateSupplierOrderStatus` ngoài transaction → partial-write window" (blind CRITICAL) — noise: supplierStatus là audit-only, không ảnh hưởng money/user state; retry idempotent (ghi lại cùng giá trị). Không phải critical.
- "Secret qua query param `?secret=` log-leak" (blind MAJOR) — by-design: reuse y hệt pattern product webhook 2.30 (header HOẶC query fallback), đã review ở 2.30. Nhất quán, không phải regression 2.33. (Có thể siết toàn cục sau, không thuộc story này.)
- "`secretMatches` duplicate không reuse" (auditor) — noise: function private trong product webhook route, copy verbatim đúng behavior; extract shared util là refactor optional, không phải bug.
- "`hasForwardedDeliverySync` chặn corrected re-delivery" (blind MAJOR) — by-design: idempotency chống gửi payload 2 lần (QĐ8) là intentional; supplier gửi credential sai rồi sửa = admin manual case (hiếm), không phải auto-flow.
- "syncMode guard chỉ ở route không ở applyOrderStatusEvent" (blind) — noise: route là entry point duy nhất; defense-in-depth optional.
- "fulfilled-without-delivery path không dedup (2 unsupported rows)" (blind MINOR) — noise: unsupported rows là metadata, trùng vô hại.
- "pollOrderStatuses stub rỗng không log / OrderStatusError dead code / test setTimeout flaky / migration double-guard / idempotent no skipped-marker / note lộ payload-presence" — noise/nit: stub đúng QĐ6 defer; OrderStatusError export sẵn cho tương lai; double-guard harmless; note chỉ ghi present/missing không phải payload.

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (BMAD Dev Story workflow)

### Debug Log References

### Completion Notes List

- `SCHEMA_VERSION = 15`, migration 013 `supplierDeliveries` (append-only, NO payload column, NFR8/D6).
- `getSupplierOrderBySupplierOrderId` added to `supplierOrdersRepo.js` — webhook event → internal order lookup (QĐ2).
- `supplierDeliveriesRepo.js` (NEW): `insertDeliverySync` / `hasForwardedDeliverySync` / `listDeliveriesByOrder` — all exported via `db/index.js`.
- `constants.js` extended: `SUPPLIER_ORDER_STATUSES`, `SUPPLIER_ORDER_STATUS_MAP` (QĐ3), `supportsOrderStatus()` capability stub (QĐ6).
- `orderStatusSync.js` (NEW): `applyOrderStatusEvent` — lookup → cross-source guard → status validate → supplierStatus audit → map → canTransition → transition in db.transaction() → forwardDeliverySync post-commit sendMessage. `fulfilled` is delivery-gated (QĐ3). Idempotency 2 layers: canTransition + hasForwardedDeliverySync (QĐ8). KHÔNG auto-refund (QĐ9). `pollOrderStatuses` no-op stub (QĐ6).
- `order-webhook/[id]/route.js` (NEW): POST endpoint, reuses `secretMatches` + uniform 401 pattern from product webhook (QĐ1).
- Tests: 34 new tests — `orderStatusSync.test.js` (19), `supplierDeliveriesRepo.test.js` (10), `supplier-deliveries-migration.test.js` (5). Full suite 1607/1668 pass (3 pre-existing ERR_DLOPEN_FAILED failures unrelated to story changes).

## File List

- `src/lib/db/schema.js` (modified — +supplierDeliveries table, SCHEMA_VERSION 15)
- `src/lib/db/migrations/013-supplier-deliveries.js` (new)
- `src/lib/db/migrations/index.js` (modified — registered m013)
- `src/lib/db/repos/supplierOrdersRepo.js` (modified — +getSupplierOrderBySupplierOrderId)
- `src/lib/db/repos/supplierDeliveriesRepo.js` (new)
- `src/lib/db/index.js` (modified — exported new repo fns)
- `src/lib/store/constants.js` (modified — +SUPPLIER_ORDER_STATUSES, +SUPPLIER_ORDER_STATUS_MAP, +supportsOrderStatus)
- `src/lib/store/orderStatusSync.js` (new)
- `src/app/api/store/suppliers/order-webhook/[id]/route.js` (new)
- `tests/unit/orderStatusSync.test.js` (new)
- `tests/unit/supplierDeliveriesRepo.test.js` (new)
- `tests/unit/supplier-deliveries-migration.test.js` (new)
- `docs/stories/2-33-external-order-status-sync-delivery-forwarding.md` (modified)

## Change Log

- 2026-06-16: Implement story 2.33 — supplier order status sync + delivery forwarding. New: `supplierDeliveries` table (migration 013, SCHEMA_VERSION 15), `supplierDeliveriesRepo`, `orderStatusSync.js` (applyOrderStatusEvent + pollOrderStatuses stub), order-webhook endpoint. Extended: supplierOrdersRepo (+getSupplierOrderBySupplierOrderId), constants (+status map/enum), db/index exports. 34 new tests, all pass.

## Status: done
