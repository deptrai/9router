---
baseline_commit: 6cb51c8
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture-store.md
  - docs/stories/2-30-external-telegram-store-sources-catalog-sync.md
  - docs/stories/2-32-external-vendor-checkout-supplier-qr-handoff.md
  - docs/stories/2-33-external-order-status-sync-delivery-forwarding.md
  - src/lib/db/schema.js
  - src/lib/db/repos/supplierSourcesRepo.js
  - src/lib/db/repos/supplierOrdersRepo.js
  - src/lib/db/repos/ordersRepo.js
  - src/lib/store/catalogSync.js
  - src/lib/store/externalCheckout.js
---

# Story 2.34: Supplier Operations, Reconciliation & Fallback Controls

Status: ready-for-dev

## Story

As an **admin vận hành external Telegram store aggregation**,
I want **theo dõi supplier health, margin, và order exceptions từ dashboard — và có fail-closed controls tự động khi supplier degraded**,
so that **tôi phát hiện sớm sự cố (supplier down, margin âm, orphan order) trước khi ảnh hưởng buyer, và không bao giờ tạo đơn mới vào supplier đang lỗi**.

## Bối cảnh và quyết định architecture

> **Story này là bước cuối của nhánh external-store (sau 2.30 sync, 2.31 markup, 2.32 checkout, 2.33 status-sync).** 2.34 = **admin observability + reconciliation sweep + fail-closed gate**. KHÔNG thêm capability mới cho supplier (không vendor_commission, không auto-fulfill). Toàn bộ là: đọc dữ liệu đã có → hiển thị → detect exceptions → flag + notify admin.

### Hiện trạng code (verified tại baseline 6cb51c8)

**Health lifecycle đã có** (`supplierSourcesRepo.js`):
- `SOURCE_STATUSES = ["active", "degraded", "unhealthy", "unsupported"]`
- `recordSyncFailure(id, error)`: `active→degraded` (1st fail), `degraded→unhealthy` (2nd+ fail)
- `recordSyncSuccess(id)`: bất kỳ status → `active`
- `listDueForPolling()`: **exclude `unhealthy`** (QĐ6/D3 — unhealthy cần admin can thiệp, không tự poll)
- `updateSourceStatus(id, status)` — admin override

**supplierOrders đã có** (`supplierOrdersRepo.js`):
- `findPaidExternalOrdersMissingSupplierOrder()` — orphan detection (paid external order không có tracking row)
- `listSupplierOrders({ supplierSourceId, supplierStatus, limit, offset })`
- `updateSupplierOrderStatus(id, fields)` — fill supplierOrderId/supplierStatus sau sync (2.33)

**Reconciliation flags đã có** (`externalCheckout.js:186`):
- `setOrderNoteSync(adapter, orderId, "NEEDS_RECONCILE: supplierOrders insert failed")` — flag khi insert tracking thất bại
- `ordersRepo.setOrderNoteSync` — đặt note trên order

**Admin routes đã có** (`src/app/api/store/admin/`):
- `orders/` — list + detail orders
- `products/` — list + manage products
- **CHƯA có** `suppliers/` admin routes

**Fail-closed hiện tại**: `catalogSync.js` không poll `unhealthy` source. Nhưng `externalCheckout.js` **CHƯA check** source health trước khi checkout → vẫn có thể tạo đơn vào supplier `unhealthy`. Đây là gap cần fix trong T3.

**Schema hiện tại** (`SCHEMA_VERSION=14`, `schema.js`):
- `supplierSources`: `status(active|degraded|unhealthy|unsupported)`, `lastSyncError`, `lastSyncedAt`, `isActive`, `paymentMode`
- `supplierOrders`: `expectedMargin`, `retailPrice`, `supplierPrice`, `supplierStatus`, `orderId`
- `orders`: `note` (dùng cho NEEDS_RECONCILE flag), `status`
- **CHƯA có** `orders.flaggedForReview` boolean — dùng `note LIKE 'NEEDS_RECONCILE%'` để detect

### Quyết định architecture

- **QĐ1 — Reconciliation sweep là scheduled job (out-of-band, không block request)**: `reconcileSupplierOrders()` (`src/lib/store/supplierReconciliation.js`, NEW) chạy định kỳ (cron-style, tương tự `runDuePolls`). Sweep: (a) orphan detection, (b) margin-negative flag, (c) stale `paid` external orders. KHÔNG auto-refund — chỉ flag + log. Admin quyết định action.
- **QĐ2 — Fail-closed checkout gate**: `externalCheckout.js` thêm check `source.status === 'unhealthy'` trước khi proceed → throw `ExternalCheckoutError('SUPPLIER_UNHEALTHY', ...)`. Fail-closed = không tạo đơn mới vào supplier đang lỗi. `degraded` vẫn cho qua (degraded = 1 lỗi, có thể tạm thời).
- **QĐ3 — Admin dashboard = REST API + Next.js page**: `GET /api/store/admin/suppliers` (list sources + health), `GET /api/store/admin/suppliers/[id]` (detail + orders), `POST /api/store/admin/suppliers/[id]/disable` (force isActive=0). Frontend: `/dashboard/admin/suppliers` page (reuse existing admin dashboard pattern).
- **QĐ4 — Margin exception = flag, không auto-refund**: Khi sweep phát hiện `supplierOrders.expectedMargin < 0` (có thể xảy ra nếu supplier thay đổi giá giữa sync cycle) → set `orders.note = 'NEEDS_REVIEW: negative margin'`. Admin xem và quyết định refund thủ công qua `reverseTxn` sẵn có.
- **QĐ5 — KHÔNG thêm cột schema mới cho 2.34**: Tận dụng `orders.note` (text) cho flag, `supplierSources.status` cho health, `supplierOrders.expectedMargin` cho margin check. Nếu cần thêm `flaggedAt` sau này → migration riêng. YAGNI.
- **QĐ6 — Admin UI hiển thị dual-status**: Internal order status (từ `orders.status`) + supplier-side status (từ `supplierOrders.supplierStatus`) side-by-side. Join query, KHÔNG 2 separate API calls.

## Acceptance Criteria

### AC1 — Admin xem danh sách supplier sources + health
**Given** admin vào `/dashboard/admin/suppliers`
**When** trang load
**Then** hiển thị bảng: name, adapterType, syncMode, status (badge màu: active=green, degraded=yellow, unhealthy=red), lastSyncedAt, lastSyncError (truncated), products count (published/total), paymentMode
**And** nút "Disable" cho source `active`/`degraded` → set `isActive=0`
**And** nút "Re-enable" cho source `isActive=0` → set `isActive=1`, reset status→`active`
**And** nút "Force sync" → trigger `syncSource(id)` manual (reuse 2.30 endpoint nếu có)

### AC2 — Admin xem order detail với dual-status
**Given** admin vào order detail của external order
**When** page load
**Then** hiển thị internal status (`orders.status`) VÀ supplier status (`supplierOrders.supplierStatus`) song song
**And** hiển thị: retailPrice, supplierPrice, expectedMargin, supplierOrderId (nếu có)
**And** nếu `orders.note` chứa `NEEDS_RECONCILE` hoặc `NEEDS_REVIEW` → hiển thị warning banner rõ ràng

### AC3 — Fail-closed: không tạo đơn mới vào supplier unhealthy
**Given** supplier source có `status='unhealthy'`
**When** user cố checkout external product từ source đó
**Then** `externalCheckout` throw `ExternalCheckoutError('SUPPLIER_UNHEALTHY', 'Nguồn cung cấp đang gặp sự cố — liên hệ admin')`
**And** KHÔNG trừ credit user, KHÔNG tạo order
**And** product từ source `unhealthy` hiển thị "Tạm ngừng" trong bot/web store
**And** `degraded` source vẫn cho checkout (1 lỗi sync, chưa đủ ngưỡng khóa)

### AC4 — Reconciliation sweep: orphan detection
**Given** có paid external order thiếu `supplierOrders` row (orphan — từ `findPaidExternalOrdersMissingSupplierOrder()`)
**When** `reconcileSupplierOrders()` chạy
**Then** mỗi orphan order được set `note = 'NEEDS_RECONCILE: missing supplierOrders row'`
**And** log warning với orderId + userId
**And** KHÔNG auto-refund, KHÔNG thay đổi order status
**And** sweep idempotent — chạy lại không duplicate flags

### AC5 — Reconciliation sweep: margin exception flag
**Given** `supplierOrders` row có `expectedMargin < 0` (supplier giá tăng sau khi sync)
**When** sweep chạy
**Then** order tương ứng được set `note = 'NEEDS_REVIEW: negative margin'` nếu chưa flagged
**And** log warning với orderId, expectedMargin, supplierPrice, retailPrice
**And** KHÔNG auto-refund

### AC6 — Reconciliation sweep: stale paid external orders
**Given** external order ở status `paid` quá 24h mà `supplierStatus` vẫn null (chưa place upstream)
**When** sweep chạy
**Then** order được set `note = 'NEEDS_REVIEW: stale paid order'`
**And** log warning
**And** threshold 24h là config constant (dễ thay đổi)

### AC7 — Backward compat
**Given** toàn bộ thay đổi 2.34
**When** chạy full test suite
**Then** local product checkout (storeCheckout) không bị ảnh hưởng
**And** catalog sync (2.30) không thay đổi
**And** external checkout với source `active`/`degraded` vẫn hoạt động bình thường
**And** 2.33 status sync không bị ảnh hưởng

## Tasks / Subtasks

- [ ] **T1 — `src/lib/store/supplierReconciliation.js`** (NEW) (AC4, AC5, AC6, QĐ1)
  - [ ] `reconcileSupplierOrders(opts?)`: sweep toàn bộ — gọi 3 check functions bên dưới
  - [ ] `detectOrphanOrders(adapter)`: `findPaidExternalOrdersMissingSupplierOrder()` → flag `NEEDS_RECONCILE: missing supplierOrders row`
  - [ ] `detectNegativeMargins(adapter)`: query `supplierOrders WHERE expectedMargin < 0` → flag order `NEEDS_REVIEW: negative margin`
  - [ ] `detectStaleOrders(adapter)`: query `orders JOIN supplierOrders WHERE orders.status='paid' AND supplierOrders.supplierStatus IS NULL AND orders.createdAt < now - STALE_THRESHOLD_MS` → flag `NEEDS_REVIEW: stale paid order`
  - [ ] `STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000` (constant, top of file)
  - [ ] Fail-soft per order — 1 order lỗi không chặn các order khác
  - [ ] Idempotent — không re-flag order đã có `note` chứa `NEEDS_RECONCILE`/`NEEDS_REVIEW`
  - [ ] Trả `{ orphans, negativeMargins, staleOrders }` counts cho logging/admin

- [ ] **T2 — Admin API routes** (AC1, AC2, QĐ3)
  - [ ] `GET /api/store/admin/suppliers` — list all `supplierSources` + join product counts (published/total). Admin-only.
  - [ ] `GET /api/store/admin/suppliers/[id]` — source detail + recent `supplierOrders` (20 rows) + counts
  - [ ] `POST /api/store/admin/suppliers/[id]/disable` — set `isActive=0` + `status='unhealthy'`. Admin-only.
  - [ ] `POST /api/store/admin/suppliers/[id]/enable` — set `isActive=1` + `status='active'`. Admin-only.
  - [ ] `POST /api/store/admin/reconcile` — trigger `reconcileSupplierOrders()` manual. Admin-only. Trả counts.
  - [ ] Extend `GET /api/store/admin/orders/[id]` — thêm join `supplierOrders` vào response nếu là external order (AC2)

- [ ] **T3 — Fail-closed gate trong `externalCheckout.js`** (AC3, QĐ2)
  - [ ] Sau bước load `source` (line ~90), thêm check: `if (source.status === 'unhealthy') throw new ExternalCheckoutError('SUPPLIER_UNHEALTHY', ...)`
  - [ ] `degraded` KHÔNG block (fail-soft — 1 lỗi sync, vẫn cho checkout)
  - [ ] `isActive === 0` đã check qua `NOT_PUBLISHED` path (product.isActive=0 khi source disabled) — document rõ

- [ ] **T4 — Ẩn product từ source unhealthy trong bot/store** (AC3)
  - [ ] Trong `GET /api/store/products` (Telegram bot + web store): filter out products từ source `status='unhealthy'` hoặc `isActive=0`
  - [ ] Hoặc: `isActive=0` đã handle từ 2.31 publish gate — verify và document. Nếu chưa đủ thì thêm join supplierSources.status check.

- [ ] **T5 — Dashboard admin page `/dashboard/admin/suppliers`** (AC1, AC2, QĐ3)
  - [ ] `src/app/dashboard/admin/suppliers/page.tsx` (NEW): table sources với health badge, counts, actions
  - [ ] `src/app/dashboard/admin/suppliers/[id]/page.tsx` (NEW): source detail + supplierOrders list + reconcile button
  - [ ] Reuse existing admin dashboard layout/components (pattern từ `/dashboard/admin/orders`)
  - [ ] Health badge: `active`=green, `degraded`=yellow, `unhealthy`=red, `unsupported`=gray
  - [ ] Warning banner nếu order note chứa `NEEDS_RECONCILE`/`NEEDS_REVIEW`

- [ ] **T6 — Scheduled reconciliation trigger** (AC4–AC6, QĐ1)
  - [ ] Thêm `reconcileSupplierOrders()` vào scheduled jobs (cron pattern tương tự `runDuePolls` trong 2.30)
  - [ ] Interval: 1h (hoặc admin-triggerable qua T2 route)
  - [ ] Log kết quả counts sau mỗi run

- [ ] **T7 — Tests** (AC1–AC7)
  - [ ] `tests/unit/supplierReconciliation.test.js` (NEW):
    - orphan detection: paid external order + no supplierOrders row → flagged
    - negative margin: expectedMargin < 0 → flagged
    - stale order: paid + supplierStatus null + > 24h → flagged
    - idempotent: re-run không re-flag
    - fail-soft: 1 order lỗi không chặn sweep
  - [ ] `tests/unit/externalCheckout-failclosed.test.js` (NEW hoặc thêm vào existing):
    - source `unhealthy` → throw `SUPPLIER_UNHEALTHY`, không trừ credit
    - source `degraded` → checkout vẫn proceed
    - source `active` → checkout proceed (regression)
  - [ ] Regression: `storeCheckout` local product không bị ảnh hưởng

## Dev Notes

### Ràng buộc bắt buộc

- **KHÔNG auto-refund** — sweep chỉ flag, admin quyết định. `reverseTxn` sẵn có (creditLedgerRepo) để admin dùng thủ công. Lý do: auto-refund trên dữ liệu stale có thể refund sai (supplier thật đã fulfill).
- **Fail-soft per order trong sweep** — 1 order lỗi DB không crash toàn sweep. Pattern: `try { flag } catch (e) { log + continue }`.
- **Idempotent flags** — check `note LIKE '%NEEDS_RECONCILE%' OR note LIKE '%NEEDS_REVIEW%'` trước khi set. Không append nhiều lần.
- **`degraded` KHÔNG block checkout** (QĐ2): degraded = 1 lỗi sync, có thể là transient. Chỉ `unhealthy` (2+ consecutive fail) mới block. Đây là trade-off conscious: ưu tiên availability hơn zero-defect khi degraded.
- **KHÔNG sửa storeCheckout.js** — fail-closed chỉ trong `externalCheckout.js`. Local product checkout không bị ảnh hưởng.
- **KHÔNG thêm cột schema mới** (QĐ5) — tận dụng `orders.note` + existing status fields.

### Pattern setOrderNoteSync

```js
// ordersRepo.js:295 — đã có
export function setOrderNoteSync(adapter, orderId, note) { ... }

// Dùng trong sweep:
import { setOrderNoteSync } from "@/lib/db/repos/ordersRepo.js";
// Check trước khi flag:
const order = adapter.get(`SELECT note FROM orders WHERE id = ?`, [orderId]);
if (!order.note?.includes('NEEDS_')) {
  setOrderNoteSync(adapter, orderId, 'NEEDS_RECONCILE: missing supplierOrders row');
}
```

### Reconciliation sweep query pattern

```js
// Stale paid external orders (AC6):
adapter.all(`
  SELECT o.id, o.userId, o.createdAt, so.supplierStatus
  FROM orders o
  JOIN orderItems oi ON oi.orderId = o.id
  JOIN products p ON p.id = oi.productId
  JOIN supplierOrders so ON so.orderId = o.id
  WHERE o.status = 'paid'
    AND p.source = 'external_telegram_store'
    AND so.supplierStatus IS NULL
    AND o.createdAt < ?
    AND (o.note IS NULL OR o.note NOT LIKE '%NEEDS_%')
`, [new Date(Date.now() - STALE_THRESHOLD_MS).toISOString()])
```

### Admin API response shape (AC1)

```json
GET /api/store/admin/suppliers
{
  "sources": [{
    "id": "...",
    "name": "...",
    "adapterType": "webhook",
    "syncMode": "webhook",
    "status": "active",          // active|degraded|unhealthy|unsupported
    "isActive": 1,
    "lastSyncedAt": "...",
    "lastSyncError": null,
    "paymentMode": "proxy_checkout",
    "productCounts": { "total": 12, "published": 8 }
  }]
}
```

### Fail-closed gate (T3) — chỉ 4 dòng thêm vào externalCheckout.js

```js
// Sau bước load source (~line 95 trong externalCheckout.js):
if (source.status === STATUS.UNHEALTHY) {
  throw new ExternalCheckoutError(
    "SUPPLIER_UNHEALTHY",
    "Nguồn cung cấp đang gặp sự cố — liên hệ admin"
  );
}
```

### Files sẽ chạm

- `src/lib/store/supplierReconciliation.js` — NEW
- `src/lib/store/externalCheckout.js` — MODIFY (thêm unhealthy gate, ~4 dòng)
- `src/app/api/store/admin/suppliers/route.js` — NEW
- `src/app/api/store/admin/suppliers/[id]/route.js` — NEW
- `src/app/api/store/admin/reconcile/route.js` — NEW
- `src/app/api/store/admin/orders/[id]/route.js` — MODIFY (thêm supplierOrders join)
- `src/app/dashboard/admin/suppliers/page.tsx` — NEW
- `src/app/dashboard/admin/suppliers/[id]/page.tsx` — NEW
- `tests/unit/supplierReconciliation.test.js` — NEW
- `tests/unit/externalCheckout-failclosed.test.js` — NEW (hoặc extend existing)

### KHÔNG được chạm

- `src/lib/store/storeCheckout.js` — local checkout không liên quan
- `src/lib/store/catalogSync.js` — sync engine (2.30), không thay đổi
- `src/lib/store/externalCheckout.js` — CHỈ thêm unhealthy gate, KHÔNG refactor logic khác
- `src/lib/db/repos/creditLedgerRepo.js` — chỉ GỌI reverseTxn nếu cần, không sửa
- `src/lib/db/schema.js` — KHÔNG thêm cột (QĐ5)

### Testing standards

- Vitest từ `tests/`: `cd tests && npm test -- unit/<file>.test.js`
- Setup: temp DATA_DIR, STORE_ENC_KEY, `delete global._dbAdapter`, `vi.resetModules()`, `await getAdapter()`
- Mock thời gian (`vi.setSystemTime`) để test stale threshold

### References

- [Source: src/lib/db/repos/supplierOrdersRepo.js] — `findPaidExternalOrdersMissingSupplierOrder`, `listSupplierOrders`
- [Source: src/lib/db/repos/supplierSourcesRepo.js] — SOURCE_STATUSES, STATUS enum, `recordSyncFailure`, `updateSourceStatus`
- [Source: src/lib/db/repos/ordersRepo.js:295] — `setOrderNoteSync`
- [Source: src/lib/store/externalCheckout.js:186] — NEEDS_RECONCILE flag pattern
- [Source: src/lib/store/catalogSync.js] — `runDuePolls` pattern cho scheduled reconcile
- [Source: src/lib/billing/creditExpirySweep.js] — fail-soft sweep pattern (scan + reconcile per item)
- [Source: docs/stories/2-32-external-vendor-checkout-supplier-qr-handoff.md] — supplierOrders schema + proxy_checkout flow
- [Source: docs/stories/2-33-external-order-status-sync-delivery-forwarding.md] — supplierStatus sync context

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (BMAD Create Story 2026-06-16)

### Completion Notes List

### File List
