# QA Boundary: telegram-bot-scraper-auto-purchase

## Bảng khớp shape

### 1. /api/store/admin/products/publish-group

| Field | Spec | Core trả | Route dùng | Test assert | Status |
|-------|------|----------|------------|-------------|--------|
| Input: groupId | string | string (validate) | ✓ | N/A | ✓ |
| Output: published | number | `{ published }` | ✓ | N/A | ✓ |
| Error handling | Error | throws Error | try-catch → 500 | N/A | ✓ |

**Core:** `markupEngine.publishAllVariantsInGroup(groupId)` → `{ published: number }`
**Route:** `POST /api/store/admin/products/publish-group` → body `{ groupId }` → trả `{ published }`
**Test:** Không có test riêng cho route này (chỉ test core qua purchaseWorker test indirect)

---

### 2. /api/store/admin/run-purchases

| Field | Spec | Core trả | Route dùng | Test assert | Status |
|-------|------|----------|------------|-------------|--------|
| Input | none | none | none | N/A | ✓ |
| Output: processed | number | `{ processed, results }` | ✓ | ✓ | ✓ |
| Output: results | array | `[{ orderId, ok, error }]` | ✓ | ✓ | ✓ |
| Error handling | Error | throws Error | try-catch → 500 | N/A | ✓ |
| Cooldown guard | 30s | in-process rate limit | ✓ | ✗ | ✗ |

**Core:** `purchaseWorker.runDuePurchases()` → `{ processed: number, results: [{ orderId, ok, error }] }`
**Route:** `POST /api/store/admin/run-purchases` → cooldown guard 30s (lines 12-13, 19-21) → trả result
**Test:** `purchaseWorker.test.js` line 380-410 assert `result.processed`, `result.results[0].ok`, `result.results[0].orderId` ✓ (chỉ test core, KHÔNG test route cooldown guard)

---

### 3. /api/store/products

| Field | Spec | Core trả | Route dùng | Test assert | Status |
|-------|------|----------|------------|-------------|--------|
| Output: products | array | array of products | ✓ | N/A | ✓ |
| Product: variantCount | number | `variantCount` (from CTE) | ✓ | N/A | ✓ |
| Product: bestSupplierName | string | `bestSupplierName` (from CTE) | ✓ | N/A | ✓ |
| Public mapping | object | map subset fields | ✓ | N/A | ✓ |

**Core:** `productsRepo.listActiveProducts()` → array với `variantCount`, `bestSupplierName` (line 95: `SELECT r.*, r.supplierName AS bestSupplierName`)
**Route:** `GET /api/store/products` → map sang `publicProducts` với `variantCount`, `bestSupplierName` (line 27: `bestSupplierName: p.bestSupplierName ?? undefined`)
**Test:** KHÔNG có test cho route này (chỉ test core function gián tiếp qua purchaseWorker test)

---

### 4. /api/store/checkout

| Field | Spec | Core trả | Route dùng | Test assert | Status |
|-------|------|----------|------------|-------------|--------|
| Input: productId | string | string | ✓ | ✓ | ✓ |
| Input: quantity | number | number (default 1) | ✓ | ✓ | ✓ |
| Output: order | object | `{ order, items, ledgerTxnId, supplierOrder, paymentMode, alreadyProcessed }` | ✓ | ✓ | ✓ |
| Output: paymentMode | string | `"auto_fulfill"` or `"proxy_checkout"` | ✓ | ✓ | ✓ |
| Output: message | string | route builds message | ✓ | N/A | ✓ |
| Error: ExternalCheckoutError | code + message | throws | catch → 400 | N/A | ✓ |

**Core:** `externalCheckout()` → `{ order, items, ledgerTxnId, supplierOrder, paymentMode, alreadyProcessed }` (line 225-232)
**Route:** `GET /api/store/checkout` → thêm `message` dựa trên `paymentMode` (line 60-62, 96)
**Test:** Không có test trực tiếp cho route này trong purchaseWorker.test.js (test chỉ mock storeCheckout, không test externalCheckout full flow)

---

### 5. /api/store/suppliers (create/update)

| Field | Spec | Core trả | Route dùng | Test assert | Status |
|-------|------|----------|------------|-------------|--------|
| Input: name | string | validate | ✓ | N/A | ✓ |
| Input: adapterType | enum | validate against ADAPTER_TYPES | ✓ | N/A | ✓ |
| Input: syncMode | enum | validate against SYNC_MODES | ✓ | N/A | ✓ |
| Output: source | object | `{ source }` | ✓ | N/A | ✓ |
| Error handling | Error | throws with prefix | catch → 422/500 | N/A | ✓ |

**Core:** `supplierSourcesRepo.createSupplierSource(body)` → `{ source }`
**Route:** `POST /api/store/suppliers` → validate input → call core → trả `{ source }`
**Test:** Không có test trong purchaseWorker.test.js (test chỉ seed source, không test route)

---

### 6. /api/store/suppliers/order-webhook/[id]

| Field | Spec | Core trả | Route dùng | Test assert | Status |
|-------|------|----------|------------|-------------|--------|
| Auth: webhook secret | string | timingSafeEqual | ✓ | N/A | ✓ |
| Input: supplierOrderId | string | string | ✓ | N/A | ✓ |
| Input: status | string | string | ✓ | N/A | ✓ |
| Input: delivery | object | `{ type, payload }` | ✓ | N/A | ✓ |
| Output: result | object | `{ ok, error? }` | ✓ | N/A | ✓ |
| Error handling | Error | throws | catch → 422/500 | N/A | ✓ |

**Core:** `orderStatusSync.applyOrderStatusEvent(id, { supplierOrderId, status, delivery })` → `{ ok, error? }`
**Route:** `POST /api/store/suppliers/order-webhook/[id]` → validate secret → call core → trả result
**Test:** Không có test trong purchaseWorker.test.js

---

### 7. Core: purchaseWorker.processAutoPurchase

| Field | Spec | Core trả | Test assert | Status |
|-------|------|----------|-------------|--------|
| Input: orderId | string | string | ✓ | ✓ |
| Output: ok | boolean | `true`/`false` | ✓ | ✓ |
| Output: error | string | error message | ✓ | ✓ |
| Output: supplierOrder | object | updated supplierOrder | ✓ | ✓ |
| Error: not paid | Error | throws → `{ ok: false, error }` | N/A | ✓ |
| Error: locked | Error | throws → `{ ok: false, error }` | N/A | ✓ |
| Error: all failed | Error | throws → `{ ok: false, error }` | N/A | ✓ |

**Core:** `processAutoPurchase(orderId)` → `{ ok: boolean, error?: string, supplierOrder?: object }` (line 111-252)
**Test:** `purchaseWorker.test.js` line 187-376 assert `result.ok`, `result.error`, `updatedSo.supplierStatus`, `updatedOrder.status` ✓

---

### 8. Core: purchaseWorker.runDuePurchases

| Field | Spec | Core trả | Test assert | Status |
|-------|------|----------|-------------|--------|
| Input | none | none | N/A | ✓ |
| Output: processed | number | count | ✓ | ✓ |
| Output: results | array | `[{ orderId, ok, error }]` | ✓ | ✓ |

**Core:** `runDuePurchases()` → `{ processed: number, results: [{ orderId, ok, error }] }` (line 258-282)
**Test:** `purchaseWorker.test.js` line 380-410 assert `result.processed`, `result.results[0].ok`, `result.results[0].orderId` ✓

---

### 9. Core: externalCheckout (proxy checkout)

| Field | Spec | Core trả | Test assert | Status |
|-------|------|----------|-------------|--------|
| Input: userId | string | string | N/A | ✓ |
| Input: productId | string | string | N/A | ✓ |
| Input: quantity | number | number | N/A | ✓ |
| Output: order | object | order object | N/A | ✓ |
| Output: supplierOrder | object | supplierOrder object | N/A | ✓ |
| Output: paymentMode | string | `"auto_fulfill"` or `"proxy_checkout"` | N/A | ✓ |
| Output: alreadyProcessed | boolean | boolean | N/A | ✓ |
| Error: NOT_EXTERNAL | ExternalCheckoutError | throws | N/A | ✓ |
| Error: MARGIN_VIOLATION | ExternalCheckoutError | throws | N/A | ✓ |
| Error: SUPPLIER_UNHEALTHY | ExternalCheckoutError | throws | N/A | ✓ |

**Core:** `externalCheckout()` → `{ order, items, ledgerTxnId, supplierOrder, paymentMode, alreadyProcessed }` (line 75-233)
**Test:** Không có test trực tiếp trong purchaseWorker.test.js (test chỉ mock storeCheckout)

---

### 10. Core: productsRepo.listActiveProducts

| Field | Spec | Core trả | Test assert | Status |
|-------|------|----------|-------------|--------|
| Output: products | array | array with variantCount, bestSupplierName | N/A | ✓ |
| Product: variantCount | number | from CTE COUNT(*) OVER | N/A | ✓ |
| Product: bestSupplierName | string | from LEFT JOIN supplierSources | N/A | ✓ |

**Core:** `listActiveProducts()` → array với `variantCount`, `bestSupplierName` (line 64-102)
**Test:** Không có test trực tiếp trong purchaseWorker.test.js

---

### 11. Core: productsRepo.listProductGroupVariants

| Field | Spec | Core trả | Test assert | Status |
|-------|------|----------|-------------|--------|
| Input: groupId | string | string | N/A | ✓ |
| Output: variants | array | array sorted by supplierPrice ASC | N/A | ✓ |
| Variant: supplierPrice | number | from products | N/A | ✓ |
| Variant: supplierSourceId | string | from products | N/A | ✓ |

**Core:** `listProductGroupVariants(groupId)` → array variants (line 109-131)
**Test:** Không có test trực tiếp trong purchaseWorker.test.js (test seed variants manually)

---

### 12. Core: supplierOrdersRepo.updateSupplierOrderStatus

| Field | Spec | Core trả | Test assert | Status |
|-------|------|----------|-------------|--------|
| Input: id | string | supplierOrders.id | N/A | ✓ |
| Input: fields | object | `{ supplierStatus, purchaseLockExpiresAt, ... }` | N/A | ✓ |
| Output: supplierOrder | object | updated row | N/A | ✓ |

**Core:** `updateSupplierOrderStatus(id, fields)` → supplierOrder object (line 125-162)
**Test:** `purchaseWorker.test.js` line 262-265 assert `updatedSo.supplierStatus`, `updatedSo.supplierOrderId`, `updatedSo.purchaseLockExpiresAt` ✓

---

### 13. Core: markupEngine.publishAllVariantsInGroup

| Field | Spec | Core trả | Test assert | Status |
|-------|------|----------|-------------|--------|
| Input: groupId | string | string | N/A | ✓ |
| Output: published | number | count of published variants | N/A | ✓ |
| Error: missing groupId | Error | throws | N/A | ✓ |

**Core:** `publishAllVariantsInGroup(groupId)` → `{ published: number }` (line 175-199)
**Test:** Không có test trực tiếp trong purchaseWorker.test.js

---

### 14. Core: catalogSync.upsertExternalProduct

| Field | Spec | Core trả | Test assert | Status |
|-------|------|----------|-------------|--------|
| Input: db | adapter | DB adapter | N/A | ✓ |
| Input: sourceId | string | supplierSources.id | N/A | ✓ |
| Input: syncVersion | number | version number | N/A | ✓ |
| Input: normalized | object | normalized product | N/A | ✓ |
| Input: now | string | ISO timestamp | N/A | ✓ |
| Output: { id, action } | object | `{ id, action: "inserted"|"updated" }` | N/A | ✓ |

**Core:** `upsertExternalProduct(db, { sourceId, syncVersion, normalized, now })` → `{ id, action }` (line 61-126)
**Test:** Không có test trực tiếp trong purchaseWorker.test.js

---

## Bẫy

### force-dynamic
- `/api/store/admin/products/publish-group/route.js`: ✓ có `export const dynamic = "force-dynamic"` (line 8)
- `/api/store/admin/run-purchases/route.js`: ✓ có `export const dynamic = "force-dynamic"` (line 8)
- `/api/store/checkout/route.js`: ✓ có `export const dynamic = "force-dynamic"` (line 4)
- `/api/store/suppliers/route.js`: ✓ có `export const dynamic = "force-dynamic"` (line 14)
- `/api/store/suppliers/order-webhook/[id]/route.js`: ✓ có `export const dynamic = "force-dynamic"` (line 17)
- `/api/store/products/route.js`: ✗ KHÔNG có `force-dynamic` (endpoint public cached, có thể OK nhưng cần verify với spec)

### auth
- `/api/store/admin/products/publish-group/route.js`: ✓ có `requireAdmin` (line 11)
- `/api/store/admin/run-purchases/route.js`: ✓ có `requireAdmin` (line 11)
- `/api/store/checkout/route.js`: ✓ có `getDashboardAuthSession` (line 30)
- `/api/store/suppliers/route.js`: ✓ có `requireAdmin` (line 17, 29)
- `/api/store/suppliers/order-webhook/[id]/route.js`: ✓ có webhook secret validation (line 37-44)
- `/api/store/products/route.js`: ✗ KHÔNG có auth (endpoint public, có thể OK theo spec)

### executor index
- `purchaseWorker` không phải executor SSE, nên không cần đăng ký trong `src/sse/executors/index.js` ✓

### error handling
- `/api/store/admin/products/publish-group/route.js`: ✓ try-catch → 500 (line 22-28)
- `/api/store/admin/run-purchases/route.js`: ✓ try-catch → 500 (line 26-29)
- `/api/store/checkout/route.js`: ✓ try-catch với ExternalCheckoutError/CheckoutError → 400/500 (line 98-107)
- `/api/store/suppliers/route.js`: ✓ try-catch với prefix match → 422/500 (line 56-70)
- `/api/store/suppliers/order-webhook/[id]/route.js`: ✓ try-catch → 422/500 (line 58-67)
- `purchaseWorker.processAutoPurchase`: ✓ trả `{ ok: false, error }` thay vì throw (line 114, 122, 126, 128, 134, 141, 169, 251)
- `externalCheckout`: ✓ throws ExternalCheckoutError với code (line 19-26)

### cooldown guard
- `/api/store/admin/run-purchases/route.js`: ✓ có in-process cooldown 30s (lines 12-13, 19-21)

---

## Drift phát hiện

### ~~1. /api/store/products - bestSupplierName không expose~~ ✅ FIXED
**Vị trí:** `src/app/api/store/products/route.js` line 18-27
**Vấn đề:** Core `listActiveProducts` trả `bestSupplierName` (line 95) nhưng route KHÔNG map vào `publicProducts`
**Spec:** Story 2-38.2 QĐ2 "Trả về product đại diện kèm `variantCount` (số supplier còn hàng) và `bestSupplierName`."
**Fix:** Route giờ expose `bestSupplierName` (line 27: `bestSupplierName: p.bestSupplierName ?? undefined`)
**Status:** ✅ RESOLVED - Core và Route khớp shape

### 2. /api/store/admin/run-purchases - cooldown guard không có test
**Vị trí:** `src/app/api/store/admin/run-purchases/route.js` lines 12-13, 19-21
**Vấn đề:** Cooldown guard 30s được implement nhưng KHÔNG có test để verify
**Spec:** Deploy gate khuyến nghị thêm guard để tránh spam
**Impact:** Test coverage thiếu - không đảm bảo cooldown guard hoạt động đúng
**Ai nên sửa:** contract-tester - thêm test cho route cooldown guard
**Mức độ:** LOW (guard đã implement, chỉ thiếu test)

### 3. /api/store/products - bestSupplierName không có test
**Vị trí:** `src/app/api/store/products/route.js`
**Vấn đề:** bestSupplierName đã được expose nhưng KHÔNG có test để verify
**Spec:** Story 2-38.2 QĐ2
**Impact:** Test coverage thiếu - không đảm bảo field được trả đúng
**Ai nên sửa:** contract-tester - thêm test cho route với bestSupplierName assertion
**Mức độ:** LOW (field đã expose, chỉ thiếu test)

---

## VERDICT: PASS (với 2 drift LOW về test coverage)

### Tổng kết
- **PASS:** 14/14 boundaries khớp shape hoàn toàn (core ↔ route)
- **DRIFT:** 2 drift LOW - test coverage thiếu cho:
  1. `/api/store/admin/run-purchases` cooldown guard
  2. `/api/store/products` bestSupplierName field

### Nếu FAIL — việc cần làm:

**contract-tester:**
- Thêm test cho `/api/store/admin/run-purchases` route cooldown guard (verify 429 response khi call < 30s)
- Thêm test cho `/api/store/products` route với assertion cho `bestSupplierName` field

---

## Chi tiết test coverage

### Tests có trong purchaseWorker.test.js:
1. ✓ processAutoPurchase - order not paid (line 187-222)
2. ✓ processAutoPurchase - purchase already locked (line 224-241)
3. ✓ processAutoPurchase - success on first supplier (line 243-283)
4. ✓ processAutoPurchase - fallback to next supplier (line 285-332)
5. ✓ processAutoPurchase - all suppliers fail (line 334-376)
6. ✓ runDuePurchases - sweep stuck order (line 380-410)

### Tests thiếu:
- ✗ Không có test cho `/api/store/admin/products/publish-group` route
- ✗ Không có test cho `/api/store/admin/run-purchases` route cooldown guard (chỉ test core `runDuePurchases`)
- ✗ Không có test cho `/api/store/checkout` route với external product + auto_fulfill
- ✗ Không có test cho `/api/store/products` route với variantCount/bestSupplierName assertion
- ✗ Không có test cho `/api/store/suppliers` create/update route
- ✗ Không có test cho `/api/store/suppliers/order-webhook/[id]` route
- ✗ Không có test cho `externalCheckout` full flow (chỉ test qua storeCheckout mock)

### Tests đã fix (code):
- ✅ `/api/store/products` route giờ expose `bestSupplierName` (line 27) - nhưng vẫn thiếu test assertion
- ✅ `/api/store/admin/run-purchases` route giờ có cooldown guard 30s (lines 12-13, 19-21) - nhưng vẫn thiếu test verification

### Mock trong purchaseWorker.test.js:
- ✓ Mock `@/lib/store/suppliers/index.js` với `getAdapter` trả adapter có `purchaseProduct` (line 16-32)
- ✓ Mock `@/lib/telegram/botClient.js` với `sendMessage` (line 34-36)
- ✓ `purchaseProductImpl` mutable mock được set trong test (line 14, 87, 253, 308, 357, 394)

### Shape mock khớp:
- ✓ `purchaseProduct` mock trả `{ ok, supplierOrderId?, delivery?, error? }` (line 253-257, 312-313, 357, 394-398) - khớp với core expectation (purchaseWorker line 205-212)
