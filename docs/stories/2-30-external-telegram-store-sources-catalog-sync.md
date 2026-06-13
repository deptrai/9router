---
baseline_commit: 97e6e55
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture-store.md
  - docs/stories/2-27-inventory-fulfillment-other-products.md
  - docs/stories/2-28-admin-product-inventory-order-management.md
  - src/lib/db/schema.js
  - src/lib/db/migrate.js
  - src/lib/db/migrations/008-entitlements.js
  - src/lib/db/repos/productsRepo.js
  - src/lib/store/storeCheckout.js
  - src/lib/telegram/botClient.js
---

# Story 2.30 — External Telegram Store Sources & Catalog Sync

Status: done

## Story

As an admin,
I want kết nối nhiều external Telegram store/supplier được phép tích hợp và đồng bộ catalog sản phẩm của họ vào store của tôi,
so that catalog luôn cập nhật từ nhiều nguồn mà KHÔNG phá vỡ flow local 2.25–2.29.

## Bối cảnh và quyết định architecture

> **Story đầu của nhánh external-store (2.30→2.34).** 2.30 = **chỉ SOURCE + SYNC**: adapter layer, supplier source CRUD, catalog sync (webhook + polling), health. Markup/publishing = 2.31, vendor checkout = 2.32, order sync/forwarding = 2.33, supplier ops/reconciliation = 2.34. KHÔNG đụng checkout/billing/routing ở story này.

### Hiện trạng code (verified tại baseline 97e6e55)

- **`products`** (`schema.js:277-289`): cột `id, kind, name, description, priceCredits, deliveryMode, targetType, targetId, stock, isActive, createdAt, updatedAt`. **CHƯA có cột `source`** → mọi product hiện là local. Notes epics yêu cầu phân biệt `local` vs `external_telegram_store`.
- **`productsRepo.js`**: `PRODUCT_KINDS` (line 5), `DELIVERY_MODES` (line 6), `createProduct`/`updateProduct` validate kind+deliveryMode. Pattern enum-const tập trung (E8). `listActiveProducts`/`listAllProducts`/`getProductById` là read dùng bởi catalog (2.25) + admin (2.28).
- **`orders`** (`schema.js:324-336`): có `source` (telegram|web) nhưng KHÔNG có supplier* fields. (External order là 2.32+, KHÔNG thuộc 2.30.)
- **`SCHEMA_VERSION = 11`** (`schema.js:2`). Migration mới nhất `008-entitlements.js` (version 8). Pattern chuẩn (2.27/2.29a): thêm declarative `TABLES` (DB mới) + migration guard `tableExists` (DB cũ); `syncSchemaFromTables` auto-ALTER cột thiếu (additive).
- **External fetch**: pattern `fetchWithTimeout` + fail-soft (architecture-store.md:197, dùng ở `botClient.js`/`googleOidc.js`/`sendEmail.js`). Telegram bot = pure-fetch, KHÔNG thêm framework (QĐ 2.25).
- **Credential encryption**: `STORE_ENC_KEY` + `productCredentials` enc pattern (2.27) — tái dùng cho supplier auth credentials (KHÔNG lưu plaintext).

### Quyết định architecture (chốt cho story này)

- **QĐ1 — bảng `supplierSources`** (nguồn external): `id, name, adapterType, authEnc (encrypted), syncMode, syncIntervalSec, status, lastSyncedAt, lastSyncError, syncVersion, isActive, createdAt, updatedAt`.
  - `adapterType` ∈ `supplier_api | channel_feed | webhook | polling_feed` (enum tập trung). Mỗi adapter có contract validate riêng.
  - `syncMode` ∈ `webhook | polling` (push vs pull).
  - `status` ∈ `active | degraded | unhealthy | unsupported` (health lifecycle).
- **QĐ2 — `products` thêm cột phân biệt nguồn** (M1 backward-compat, giống 2.29a `ownerUserId`):
  - `source TEXT DEFAULT 'local'` — local product cũ KHÔNG đổi (tuyệt đối backward-compat); external = `'external_telegram_store'`.
  - `supplierSourceId TEXT` (nullable, FK-less) — trỏ tới `supplierSources.id`.
  - `supplierProductId TEXT` (nullable) — id sản phẩm bên supplier (dedup sync).
  - `syncVersion INTEGER`, `lastSyncedAt TEXT` (nullable) — audit sync.
  - ⚠️ Local product: `source='local'`, các cột supplier `null` → flow 2.25-2.29 KHÔNG đổi.
- **QĐ3 — Adapter layer** (`src/lib/store/suppliers/`): mỗi adapterType có module `{type}Adapter.js` export `{ validate(config), fetchCatalog(source), normalizeProduct(raw) }`. Registry tập trung map adapterType → adapter. Adapter KHÔNG hợp tác (scrape UI/private bot) → `validate` reject với lý do "out-of-scope MVP".
- **QĐ4 — Validate khi lưu source (AC1/AC2)**: `createSupplierSource` validate adapterType hợp lệ + auth credentials qua `adapter.validate()` + syncMode tương thích. adapterType không nằm trong enum → reject. Bot/store không có cơ chế tích hợp được phép → đánh dấu `status='unsupported'` + giải thích.
- **QĐ5 — Sync: webhook push (AC3) + polling (AC4)**:
  - Webhook: endpoint nhận event supplier (product/price/stock/status change) → cập nhật external product gần realtime, bump `syncVersion`, set `lastSyncedAt`. Bảo mật giống Telegram webhook (secret token + timingSafeEqual, pattern 2.25).
  - Polling: job theo `syncIntervalSec` → `adapter.fetchCatalog` delta → upsert changed products → mark `stale` nếu quá hạn sync.
  - **Stale guard**: external product quá hạn sync (lastSyncedAt + threshold) KHÔNG được bán như "chắc còn stock" — catalog/checkout phải biết.
- **QĐ6 — Health degradation (AC5)**: sync fail liên tiếp N lần → `status='degraded'` rồi `'unhealthy'`; lưu `lastSyncError`. Admin thấy lỗi sync cuối. Pattern giống health-aware account selection (auth.js).
- **QĐ7 — KHÔNG đụng checkout/billing/routing**: 2.30 chỉ nạp + đồng bộ catalog. Bán external product (markup, vendor checkout, margin) là 2.31+. External product có thể hiển thị nhưng checkout external KHÔNG thuộc story này — nếu cần gate, để `isActive=0` hoặc flag "chưa bán được" cho tới 2.31.
- **QĐ8 — Credential bảo mật (AC1)**: `authEnc` mã hoá bằng `STORE_ENC_KEY` (tái dùng helper 2.27). API trả source KHÔNG bao giờ trả authEnc plaintext (chỉ trả masked/boolean "hasAuth").

## Acceptance Criteria

### AC1 — Cấu hình supplier source hợp lệ (FR external-store)
**Given** admin cấu hình một supplier source (adapterType, auth, syncMode)
**When** source được lưu qua API
**Then** hệ thống validate adapterType ∈ enum, auth credentials qua `adapter.validate()`, syncMode tương thích, set `status='active'`
**And** auth credentials lưu mã hoá (`authEnc`), KHÔNG trả plaintext trong bất kỳ response nào.

### AC2 — Reject nguồn không hỗ trợ tích hợp (out-of-scope MVP)
**Given** admin cố cấu hình Telegram bot/store KHÔNG có API/webhook/feed/channel access được supplier cho phép
**When** source được validate
**Then** hệ thống reject HOẶC đánh dấu `status='unsupported'`
**And** thông báo rõ scrape UI/private bot không thuộc MVP.

### AC3 — Webhook push → cập nhật gần realtime (audit syncVersion)
**Given** supplier hỗ trợ webhook/event push, source `syncMode='webhook'`
**When** supplier thay đổi product/price/stock/status và gửi event (đúng secret)
**Then** hệ thống cập nhật external product tương ứng, bump `syncVersion`, set `lastSyncedAt`
**And** webhook xác thực secret (timingSafeEqual); event sai secret → reject.

### AC4 — Polling delta → cập nhật + stale guard
**Given** supplier không webhook nhưng có API/feed polling được phép, `syncMode='polling'`
**When** polling job chạy theo `syncIntervalSec`
**Then** hệ thống fetch delta catalog, upsert changed products, set `lastSyncedAt`
**And** product quá hạn sync (lastSyncedAt + threshold) được mark `stale` và KHÔNG bán như hàng chắc còn stock.

### AC5 — Sync fail → source degraded/unhealthy
**Given** supplier API lỗi hoặc rate-limited
**When** sync thất bại nhiều lần liên tiếp
**Then** source chuyển `degraded` rồi `unhealthy`, lưu `lastSyncError`
**And** admin thấy lỗi sync cuối cùng + trạng thái health.

### AC6 — KHÔNG regression flow local (M1, F7-style)
**Given** toàn bộ thay đổi 2.30
**When** chạy full unit suite + thao tác product local (2.25-2.28)
**Then** local product (`source='local'`, supplier cột null) hành vi KHÔNG đổi: catalog, checkout, admin CRUD chạy y hệt
**And** test chứng minh local product không bị adapter/sync đụng tới.

## Tasks / Subtasks

- [x] **T1 — Schema: `supplierSources` table + `products` external cột + migration** (AC1, AC6)
  - [x] Thêm bảng `supplierSources` vào `TABLES` (`schema.js`) camelCase (QĐ1) + index `idx_supplier_status`, `idx_supplier_active`.
  - [x] Thêm vào `products.columns`: `source TEXT DEFAULT 'local'`, `supplierSourceId TEXT`, `supplierProductId TEXT`, `syncVersion INTEGER`, `lastSyncedAt TEXT` (đều nullable trừ source có default — QĐ2 backward-compat).
  - [x] Index `idx_products_source` + `idx_products_supplier (supplierSourceId, supplierProductId)` cho dedup sync.
  - [x] Bump `SCHEMA_VERSION = 12`.
  - [x] Tạo `src/lib/db/migrations/009-external-store-sources.js` (version 9): guard `tableExists`/column-present, `ALTER products ADD COLUMN ...` nếu thiếu, `CREATE TABLE IF NOT EXISTS supplierSources`. Đăng ký `migrations/index.js`.
  - [x] Verify thứ tự migration versioned chạy trước `syncSchemaFromTables`; DB mới + cũ đều đúng. (migrate log #1–#9 applied trong test.)

- [x] **T2 — `supplierSourcesRepo.js`** (AC1, AC5)
  - [x] `ADAPTER_TYPES`, `SYNC_MODES`, `SOURCE_STATUSES` (enum tập trung E8).
  - [x] `createSupplierSource(data)` — validate adapterType ∈ enum, auth qua `adapter.validate()`, encrypt auth → `authEnc` (STORE_ENC_KEY). KHÔNG trả plaintext.
  - [x] `listSupplierSources()`, `getSupplierSourceById(id)` — mask auth (trả `hasAuth: boolean`, KHÔNG authEnc).
  - [x] `updateSupplierSource`, `recordSyncSuccess(id, {syncVersion})`, `recordSyncFailure(id, error)` (degraded/unhealthy lifecycle, QĐ6).
  - [x] `markSourceUnsupported(id, reason)` (AC2).
  - [x] Export qua `src/lib/db/index.js`.

- [x] **T3 — Adapter layer** (`src/lib/store/suppliers/`) (QĐ3, AC2, AC4)
  - [x] Registry `index.js` map `adapterType → adapter`; `getAdapter(type)` throw nếu unknown.
  - [x] Mỗi adapter: `validate(config)`, `fetchCatalog(source)`, `normalizeProduct(raw)`. Adapter types: `supplier_api`, `channel_feed`, `polling_feed`, `webhook`.
  - [x] Adapter KHÔNG hợp tác (scrape/private bot) → `validate` reject lý do "out-of-scope MVP" (AC2).
  - [x] `fetchCatalog` dùng `fetchWithTimeout` + fail-soft (KHÔNG throw lên crash sync job).

- [x] **T4 — Catalog sync engine** (`src/lib/store/catalogSync.js`) (AC3, AC4, AC5)
  - [x] `syncSource(sourceId)`: gọi `adapter.fetchCatalog` → normalize → upsert external products (dedup theo `supplierProductId`), bump `syncVersion`, set `lastSyncedAt`, `recordSyncSuccess`. Lỗi → `recordSyncFailure`.
  - [x] `applyWebhookEvent(sourceId, event)` (AC3): cập nhật 1 external product từ event push.
  - [x] Stale detection: `isProductStale(product, thresholdSec)` (AC4) — lastSyncedAt quá hạn → stale.
  - [x] Upsert external product: `source='external_telegram_store'`, gắn supplierSourceId/supplierProductId. KHÔNG đụng local product.

- [x] **T5 — API routes + webhook + polling trigger** (AC1–AC5)
  - [x] `src/app/api/store/suppliers/route.js` — GET (list, masked) + POST (create, validate). Admin-only (requireAdmin).
  - [x] `src/app/api/store/suppliers/[id]/route.js` — GET/PUT/DELETE + POST `?action=sync` (trigger sync thủ công). Admin-only.
  - [x] `src/app/api/store/suppliers/webhook/[id]/route.js` — nhận webhook supplier, verify secret (timingSafeEqual), `applyWebhookEvent`. `force-dynamic`.
  - [x] Polling: hàm `runDuePolls()` (`catalogSync.js`) quét source `syncMode='polling'` quá hạn interval → `syncSource`. (Trigger cron/manual; fail-soft per source; KHÔNG self-schedule.)

- [x] **T6 — Tests** (AC1–AC6)
  - [x] `tests/unit/supplierSourcesRepo.test.js` (mới): create/validate/enum guard, auth encrypt + mask (không leak plaintext), degraded/unhealthy lifecycle, markUnsupported.
  - [x] `tests/unit/catalogSync.test.js` (mới): syncSource upsert+dedup+syncVersion bump; webhook event apply; stale detection; fail → recordSyncFailure.
  - [x] `tests/unit/store-suppliers-adapter.test.js` (mới): registry getAdapter unknown throw; validate reject scrape/unsupported (AC2).
  - [x] **Regression (AC6)**: local product (`source='local'`) vẫn trả trong `listActiveProducts`/catalog; sync KHÔNG đụng local; `createProduct` local không cần supplier cột.

### Review Findings

#### [Review][Decision] — cần quyết định trước khi patch
- [x] [Review][Decision] `deleteSupplierSource` để lại orphaned external products — DELETE source KHÔNG cascade/nullify `products WHERE supplierSourceId=?`. Dangling ref → 2.31 publishing surface product mồ côi. Chọn: cascade-delete external products / nullify supplier cột / block delete khi còn product. [supplierSourcesRepo.js:151]
- [x] [Review][Decision] Stale guard KHÔNG persist thành flag — spec QĐ5/Dev Notes nói "2.30 set flag", impl chỉ compute on-the-fly `isProductStale()` (không có cột `isStale` lưu DB). 2.31 consumer phải tự re-implement threshold. Chọn: thêm cột persisted vs giữ computed (chấp nhận lệch wording spec). [catalogSync.js:165]
- [x] [Review][Decision] `listPollableSources` poll cả source `unhealthy` — SQL chỉ loại `unsupported`, nên `unhealthy` vẫn bị poll mỗi interval (comment line 210 ghi "active/degraded" → code/comment mismatch), không backoff. Chọn: unhealthy auto-retry (heal) vs dừng tới khi admin can thiệp (QĐ6 "admin thấy lỗi"). [supplierSourcesRepo.js:213]

#### [Review][Patch] — fix không cần input
- [x] [Review][Patch] `updateSupplierSource` bỏ qua `adapter.validate()` khi đổi auth (AC1/QĐ4 — validate mỗi lần save) [supplierSourcesRepo.js:141]
- [x] [Review][Patch] SSRF/data-bug: `auth.apiUrl || source.name` → dùng tên source làm URL khi thiếu apiUrl (bỏ fallback, throw nếu thiếu) [supplierApiAdapter.js:25]
- [x] [Review][Patch] Silent decrypt fallback `catch { auth = {} }` → sync chạy với creds rỗng, lỗi gây hiểu nhầm transient. Record lỗi "auth decrypt failed" rõ ràng thay vì âm thầm [supplierSourcesRepo.js:121]
- [x] [Review][Patch] `syncSource` trên source adapterType=`webhook` → `fetchCatalog` trả error → `recordSyncFailure` degrade health oan. Skip webhook-type trong syncSource/runDuePolls [catalogSync.js:96]
- [x] [Review][Patch] `upsertExternalProduct` UPDATE ghi đè `isActive` do admin set (publishing gate 2.31, QĐ7) — UPDATE phải giữ nguyên isActive hiện có, chỉ INSERT set 0 [catalogSync.js:39]
- [x] [Review][Patch] Lỗi `STORE_ENC_KEY is required` leak nguyên văn ra client — regex 422 `/required/i` match → echo `e.message`. Siết regex/sanitize [route.js:62]
- [x] [Review][Patch] `syncIntervalSec` không validate — 0 → interval 0ms → poll vô hạn max rate. Enforce min interval ở create/update [supplierSourcesRepo.js:81,137]
- [x] [Review][Patch] `getSupplierSourceWithAuth` export qua barrel công khai `db/index.js` — mở rộng truy cập decrypted creds; cả 2 caller import trực tiếp từ repo nên export này thừa. Gỡ bỏ [db/index.js:74]
- [x] [Review][Patch] `secretMatches` early-return khi length mismatch → leak độ dài secret qua timing. HMAC cả 2 vế về digest cùng độ dài [webhook/[id]/route.js:22]
- [x] [Review][Patch] `webhookAdapter.validate` check `scrape` SAU `webhookSecret` → config scrape thiếu secret trả "webhookSecret required" thay vì `unsupported` (AC2). Đảo thứ tự check scrape trước [webhookAdapter.js:4]
- [x] [Review][Patch] `normalizeProduct` trả `supplierProductId=""` → `syncSource` âm thầm `continue` (data loss, không count/warn). Đếm skipped + surface trong result [catalogSync.js:110]
- [x] [Review][Patch] Webhook endpoint: 404 (unknown) vs 401 (bad secret) → source-existence oracle; thiếu guard `syncMode==='webhook'`. Trả 401 thống nhất + check syncMode [webhook/[id]/route.js:31,43]
- [x] [Review][Patch] `updateSupplierSource` validate `syncMode` SAU khi build `next` (ordering nit; throw trước DB write nên hiện vô hại). Đưa validate lên đầu [supplierSourcesRepo.js:137]

#### [Review][Defer] — pre-existing / hoãn
- [x] [Review][Defer] `syncVersion` race read-compute-write không lock — 2 sync concurrent mất 1 increment [catalogSync.js:102] — deferred, MVP single-process sequential (no cron infra), risk thấp
- [x] [Review][Defer] `db.transaction()` giả định sync-driver (better-sqlite3) — latent nếu đổi async driver [catalogSync.js:107] — deferred, không phải bug hiện tại

## Dev Notes

### Ràng buộc bắt buộc

- **M1/backward-compat (AC6)**: `products.source DEFAULT 'local'` — KHÔNG default khác. Local product cũ (`source` thêm mới → 'local') không đổi catalog/checkout. Đây là điểm dev hay sai: nếu default sai hoặc filter catalog theo source mà quên local → vỡ 2.25-2.28.
- **Credential bảo mật (AC1/QĐ8)**: tái dùng enc helper của 2.27 (`STORE_ENC_KEY`). API list/get source PHẢI mask — grep response đảm bảo không có authEnc/plaintext. Pattern giống `productCredentials` 2.27.
- **Fail-soft sync (AC5)**: `fetchCatalog`/polling job KHÔNG được throw làm crash. Lỗi → `recordSyncFailure` + degraded. Pattern `fetchWithTimeout` + try/catch (architecture-store.md:197).
- **Webhook security (AC3)**: secret token + `timingSafeEqual`, anti-replay — pattern Telegram webhook 2.25 (`router.js` setup-webhook). Sai secret → reject, KHÔNG xử lý event.
- **Scope guard (QĐ7)**: KHÔNG đụng `storeCheckout.js`, billing, routing. External product chỉ nạp + đồng bộ. Bán external (markup/margin/vendor checkout) = 2.31-2.34. Nếu thấy cần sửa checkout → DỪNG, lệch scope.
- **Stale ≠ bán chắc (AC4)**: external product stale phải có flag để catalog/checkout sau này biết "không chắc còn stock". 2.30 set flag; tiêu thụ đầy đủ ở 2.31+.

### Adapter contract (QĐ3)

```
validate(config)        → { ok: boolean, reason?: string }   // AC1/AC2
fetchCatalog(source)    → { products: RawProduct[] }          // fail-soft
normalizeProduct(raw)   → { supplierProductId, name, priceCredits?, stock?, ... }
```
Adapter `webhook` không có `fetchCatalog` (push-only) → polling skip; `validate` chỉ check secret config.

### Files sẽ chạm

- `src/lib/db/schema.js` — MODIFY (+supplierSources, +5 cột products, bump VERSION)
- `src/lib/db/migrations/009-external-store-sources.js` — NEW
- `src/lib/db/migrations/index.js` — MODIFY (đăng ký m009)
- `src/lib/db/repos/supplierSourcesRepo.js` — NEW
- `src/lib/db/repos/productsRepo.js` — MODIFY (hỗ trợ source/supplier cột trong create/update; KHÔNG đổi default local)
- `src/lib/db/index.js` — MODIFY (export repo mới)
- `src/lib/store/suppliers/` — NEW (registry + adapters)
- `src/lib/store/catalogSync.js` — NEW
- `src/app/api/store/suppliers/route.js`, `[id]/route.js`, `webhook/[id]/route.js` — NEW
- `tests/unit/supplierSourcesRepo.test.js`, `catalogSync.test.js`, `store-suppliers-adapter.test.js` — NEW

### KHÔNG được chạm (scope guard)

- `src/lib/store/storeCheckout.js`, billing, routing (`auth.js`) — đó là 2.32+. 2.30 chỉ source + sync catalog.
- Flow local product 2.25-2.28 — chỉ thêm cột nullable, KHÔNG đổi hành vi.

### Testing standards

- Vitest từ `tests/`: `cd tests && npm test -- unit/<file>.test.js` (alias `@/`→`src/`). Deps `/tmp/node_modules`.
- Setup giống `storeCheckout.test.js`/`supplierSourcesRepo`: temp DATA_DIR, `STORE_ENC_KEY`, `delete global._dbAdapter`, `vi.resetModules()`, `await getAdapter()`.
- Mock supplier fetch: stub `adapter.fetchCatalog` (thành công + throw) để test sync + degraded.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-2.30] — AC gốc BDD.
- [Source: _bmad-output/planning-artifacts/epics.md:191-194] — notes external adapter, supplier fields, source phân biệt local/external.
- [Source: _bmad-output/planning-artifacts/architecture-store.md:197] — fetchWithTimeout + fail-soft.
- [Source: src/lib/db/schema.js:277-289] — products columns (chưa có source).
- [Source: src/lib/db/repos/productsRepo.js:5-6] — PRODUCT_KINDS/DELIVERY_MODES enum pattern.
- [Source: src/lib/db/migrations/008-entitlements.js] — pattern migration guard tableExists + nullable cột.
- [Source: docs/stories/2-27-inventory-fulfillment-other-products.md] — STORE_ENC_KEY credential enc pattern.

## Dev Agent Record

### Agent Model Used

opus-4.8 (BMAD Dev Story workflow)

### Debug Log References

- Full unit suite: **1427 passed, 0 fail, 24 skipped** (139 files) — AC6 no-regression verified.
- New tests: 40 passed (supplierSourcesRepo 12, catalogSync 13, store-suppliers-adapter 15).
- Migration #9 `external-store-sources` applied cleanly on fresh + existing DBs (verified migrate log).

### Completion Notes List

- **T1 — Schema + migration**: `supplierSources` table (camelCase, +`idx_supplier_status`/`idx_supplier_active`) + 5 nullable cột `products` (`source DEFAULT 'local'`, `supplierSourceId`, `supplierProductId`, `syncVersion`, `lastSyncedAt`) + `idx_products_source`/`idx_products_supplier`. `SCHEMA_VERSION = 12`. Migration `009-external-store-sources.js` guard `tableExists`/column-present (ALTER additive), đăng ký `migrations/index.js`. Local product cũ → `source='local'` (M1 backward-compat, AC6).
- **T2 — `supplierSourcesRepo.js`**: enums `ADAPTER_TYPES`/`SYNC_MODES`/`SOURCE_STATUSES` (E8). `createSupplierSource` validate adapterType + `adapter.validate()` + encrypt auth (`STORE_ENC_KEY`). `listSupplierSources`/`getSupplierSourceById` mask → `hasAuth: boolean` (KHÔNG leak authEnc, QĐ8). `getSupplierSourceWithAuth` (internal, decrypt) cho catalogSync. Health lifecycle `recordSyncSuccess`/`recordSyncFailure` (active→degraded→unhealthy, QĐ6). `markSourceUnsupported` (AC2). `listPollableSources`. Export qua `db/index.js`.
- **T3 — Adapter layer** (`src/lib/store/suppliers/`): registry `index.js` (`getAdapter` throw nếu unknown) + 4 adapter (`supplier_api`/`channel_feed`/`polling_feed`/`webhook`). Mỗi adapter `validate`/`fetchCatalog`/`normalizeProduct`. Scrape/private-bot config → `validate` reject `unsupported` (AC2). `fetchCatalog` dùng `fetchWithTimeout` (AbortController) + fail-soft (trả `{products:[], error}` thay vì throw). `webhook` adapter push-only (fetchCatalog no-op).
- **T4 — `catalogSync.js`**: `syncSource` (fetchCatalog → normalize → upsert dedup theo `supplierSourceId+supplierProductId`, bump syncVersion, recordSyncSuccess; lỗi → recordSyncFailure). `applyWebhookEvent` (AC3). `isProductStale` (AC4, local NEVER stale). `runDuePolls` (T5 polling driver, fail-soft per-source). Upsert external: `source='external_telegram_store'`, `isActive=0` (gate tới 2.31 publishing, QĐ7). KHÔNG đụng local product.
- **T5 — API routes**: `suppliers/route.js` (GET list masked + POST create, `requireAdmin`), `suppliers/[id]/route.js` (GET/PUT/DELETE + POST `?action=sync`, admin-only), `suppliers/webhook/[id]/route.js` (verify secret `timingSafeEqual` + `applyWebhookEvent`, `force-dynamic`). `runDuePolls` cho cron/manual trigger.
- **T6 — Tests**: 3 file mới, 40 tests, AC1–AC6 phủ. Regression AC6: local product survive sync, `createProduct` local không cần supplier cột, sync chỉ thêm external.
- **Scope guard (QĐ7)**: KHÔNG đụng `storeCheckout.js`/billing/routing. External product nạp + đồng bộ only; bán = 2.31+.

### File List

- `src/lib/db/schema.js` — MODIFY (+supplierSources, +5 cột products, +indexes, SCHEMA_VERSION 12)
- `src/lib/db/migrations/009-external-store-sources.js` — NEW
- `src/lib/db/migrations/index.js` — MODIFY (đăng ký m009)
- `src/lib/db/repos/supplierSourcesRepo.js` — NEW
- `src/lib/db/repos/productsRepo.js` — MODIFY (rowToProduct +source/supplier cột)
- `src/lib/db/index.js` — MODIFY (export supplierSourcesRepo)
- `src/lib/store/suppliers/index.js` — NEW (registry)
- `src/lib/store/suppliers/supplierApiAdapter.js` — NEW
- `src/lib/store/suppliers/channelFeedAdapter.js` — NEW
- `src/lib/store/suppliers/pollingFeedAdapter.js` — NEW
- `src/lib/store/suppliers/webhookAdapter.js` — NEW
- `src/lib/store/catalogSync.js` — NEW
- `src/app/api/store/suppliers/route.js` — NEW
- `src/app/api/store/suppliers/[id]/route.js` — NEW
- `src/app/api/store/suppliers/webhook/[id]/route.js` — NEW
- `tests/unit/supplierSourcesRepo.test.js` — NEW
- `tests/unit/catalogSync.test.js` — NEW
- `tests/unit/store-suppliers-adapter.test.js` — NEW

