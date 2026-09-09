---
baseline_commit: 1aa618c
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture-store.md
  - docs/stories/2-30-external-telegram-store-sources-catalog-sync.md
  - src/lib/db/schema.js
  - src/lib/db/repos/productsRepo.js
  - src/lib/store/catalogSync.js
  - src/lib/db/repos/supplierSourcesRepo.js
---

# Story 2.31: External Product Markup & Publishing

Status: done

## Story

As an admin,
I want đặt `% lợi nhuận` và publish sản phẩm external vào bot store của mình,
so that user thấy giá bán cuối cùng và tôi kiểm soát margin.

## Bối cảnh và quyết định architecture

> **Story này là bước tiếp theo của nhánh external-store sau 2.30 (source + sync).** 2.31 = **markup rules + retail pricing + publishing gate**: admin set markup → hệ thống tính retailPrice → admin publish product để user có thể thấy trong `/products`. KHÔNG đụng checkout/billing (= 2.32+), KHÔNG đụng routing.

### Hiện trạng code (verified tại baseline 1aa618c)

- **`products` table** (`schema.js:276-302`): `source TEXT DEFAULT 'local'`, `supplierSourceId`, `supplierProductId`, `syncVersion`, `lastSyncedAt`. **CHƯA có cột** `supplierPrice`, `retailPrice`, `expectedMargin`, `isPublished`. External product khi sync từ `catalogSync.js` có `isActive=0` (gate tới 2.31, QĐ7 trong 2.30). `priceCredits` = supplier price (raw) hiện tại.
- **`catalogSync.upsertExternalProduct`** (`catalogSync.js:25-74`): khi INSERT external product, `priceCredits = Number(normalized.priceCredits ?? 0)` — đây là **supplier price**. Sau 2.31 cần persist `supplierPrice` riêng để markup rule có thể tính lại retailPrice khi margin thay đổi.
- **`productsRepo.js`**: `rowToProduct`, `listActiveProducts` (WHERE isActive=1), `updateProduct` (partial patch). `listActiveProducts` không lọc source — sau 2.31 external product `isPublished=1` + `isActive=1` phải hiển thị.
- **`supplierSourcesRepo.js`**: `ADAPTER_TYPES`, `SYNC_MODES`, `SOURCE_STATUSES` enums — pattern enum tập trung (E8). Tương tự cần enum tập trung cho `markupRules`.
- **`SCHEMA_VERSION = 12`** (`schema.js:2`). Migration mới nhất: `009-external-store-sources.js` (version 9). Pattern guard `tableExists`/column-present + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` cho DB cũ.
- **`storeCheckout.js`**: KHÔNG đụng. Markup/retailPrice ảnh hưởng display và publish, KHÔNG ảnh hưởng checkout cho tới 2.32 (vendor checkout).

### Quyết định architecture (chốt cho story này)

- **QĐ1 — Bảng `markupRules`** (tập trung pricing rule):
  ```
  id, supplierId TEXT (FK-less ref supplierSources.id, nullable),
  productId TEXT (FK-less ref products.id, nullable), markupPct REAL NOT NULL,
  roundingRule TEXT DEFAULT 'none', isActive INTEGER DEFAULT 1,
  createdAt TEXT, updatedAt TEXT
  ```
  Thứ tự ưu tiên khi apply: **product-level > supplier-level > global (supplierId=null, productId=null)**. Mỗi external product lookup rule theo thứ tự đó, lấy rule đầu tiên khớp.
  > **⚠️ Tier `category` ĐÃ BỎ (review patch CRITICAL #2):** `products` table KHÔNG có cột `category`, nên category-level rule không bao giờ có gì để bind → dead rows. Epic AC1 nhắc "supplier, category, hoặc product" nhưng category không có data nguồn ở external sync. MVP chỉ 3 tier: product > supplier > global. Nếu sau này cần category, thêm cột `category TEXT` vào `products` + định nghĩa cách populate khi sync (story riêng).

- **QĐ2 — `products` thêm cột pricing** (backward-compat, nullable — local product null):
  - `supplierPrice REAL` — giá gốc từ supplier (lưu riêng, không bị ghi đè bởi markup)
  - `retailPrice REAL` — giá bán sau markup (hiển thị cho user)
  - `expectedMargin REAL` — `retailPrice - supplierPrice` (lưu để order audit)
  - `isPublished INTEGER DEFAULT 0` — gate admin publish; external product cần `isPublished=1` AND `isActive=1` để bán

- **QĐ3 — `calculateRetailPrice(supplierPrice, markupPct, roundingRule)`** (pure function, `src/lib/store/markupEngine.js`):
  - `retailPrice = supplierPrice * (1 + markupPct / 100)`
  - `roundingRule`: `none`, `ceil` (Math.ceil), `floor`, `round` (nearest integer). **Kể cả `none` cũng round tối thiểu 6 decimal** (`Math.round(n*1e6)/1e6`) để chặn float drift BP-6 (vd `14.999999999999998` → `15`). (review defer — BP-6 mitigation)
  - Validate: **`markupPct <= 0` → throw** (review patch MINOR: `retailPrice <= supplierPrice` ⟺ `markupPct <= 0` với supplierPrice dương, nên check trực tiếp `markupPct`). Markup phải dương. Zero-markup pass-through nếu cần là special case riêng (chưa trong scope).
  - **Pure function, không DB** — dễ unit test, không side effect

- **QĐ4 — `applyMarkupToProduct(productId, db?)` trong `markupEngine.js`**:
  - Nhận optional `db` adapter (pattern E7): nếu được gọi từ trong một transaction đang mở (vd `upsertExternalProduct`) → dùng `db` truyền vào, KHÔNG mở transaction lồng (better-sqlite3 throw nếu nest).
  - **Toàn bộ lookup rule + tính toán + UPDATE chạy trong CÙNG 1 transaction** (lookup 4-tier + UPDATE atomic — tránh rule bị edit giữa các lần read, WAL không block write).
  - Lookup `markupRules` theo thứ tự ưu tiên QĐ1 (product → supplier → global)
  - Tính `retailPrice` + `expectedMargin = retailPrice - supplierPrice`
  - UPDATE products SET `retailPrice`, `expectedMargin`, `priceCredits=retailPrice` (vì checkout đọc `priceCredits`)
  - ⚠️ **CRITICAL (review)**: khi gọi từ sync (`upsertExternalProduct`), markup-apply PHẢI inline trong cùng transaction của upsert — KHÔNG để 2 transaction tách biệt. Nếu tách: giữa lần write `priceCredits=supplierPrice` (raw) và lần re-apply markup, `storeCheckout` có thể đọc giá supplier thô. Giải: UPDATE path của upsert KHÔNG tự ghi `priceCredits` — chỉ ghi `supplierPrice`; `priceCredits` CHỈ được set bởi `applyMarkupToProduct` gọi inline ngay sau đó trong cùng transaction.

- **QĐ5 — `publishProduct(productId)` / `unpublishProduct(productId)`** trong `markupEngine.js`:
  - `publishProduct`: validate `supplierPrice` set, `retailPrice` set (markup đã apply), `retailPrice > 0` → SET `isPublished=1`, `isActive=1`
  - `unpublishProduct`: SET `isPublished=0`, `isActive=0`
  - **Enforce invariant `isPublished=1 ⇒ isActive=1`** (patch review): `updateProduct` (productsRepo.js) PHẢI reject thay đổi `isActive` trực tiếp trên external product (`source='external_telegram_store'`) → bắt buộc dùng `publishProduct`/`unpublishProduct`. Tránh state lệch: admin set `isActive=0` qua `updateProduct` trên product `isPublished=1` → biến mất khỏi catalog nhưng `isPublished` vẫn 1. Local product không bị ràng buộc này (vẫn dùng `updateProduct.isActive` tự do).
  - "Admin lock" (AC3) = trạng thái `isPublished=0` do admin chủ động `unpublishProduct`. Sync KHÔNG bao giờ tự `publishProduct` → product unpublished bởi admin ở yên unpublished qua mọi sync.

- **QĐ6 — Sync integration** (patch review — atomic + no-state-override): khi `catalogSync.upsertExternalProduct` cập nhật product, phải:
  - UPDATE `supplierPrice` = `normalized.priceCredits` (giá gốc supplier).
  - **KHÔNG ghi `priceCredits` trực tiếp ở UPDATE path** — `priceCredits` chỉ được set bởi `applyMarkupToProduct` (gọi inline, pass `db` adapter trong CÙNG transaction của upsert, pattern E7). Tránh window giữa 2 transaction nơi `priceCredits` = raw supplier price → checkout đọc sai.
  - Nếu product đã có markup rule (`findApplicableRule`) → `applyMarkupToProduct(db)` inline ngay sau khi ghi `supplierPrice`, cùng transaction.
  - Nếu chưa có rule → UPDATE `supplierPrice` only, `priceCredits` giữ nguyên giá trị cũ, `isPublished=0`. (INSERT row mới: `priceCredits = supplierPrice` làm initial default — xem T4, tránh NOT NULL default 0.)
  - **Mọi path (poll + webhook `applyWebhookEvent`) TUYỆT ĐỐI KHÔNG ghi `isActive` hay `isPublished`** — kể cả khi supplier payload/`webhookAdapter.normalizeProduct` có field `isActive`. Publish state là nguồn truth của admin, không phải supplier. UPDATE statement chỉ chứa: `supplierPrice/retailPrice/expectedMargin/priceCredits/stock/syncVersion/lastSyncedAt/updatedAt`.

- **QĐ7 — `listActiveProducts` sau 2.31**: external product hiển thị khi `isActive=1 AND isPublished=1`. Local product vẫn hiển thị khi `isActive=1`. Không thay đổi query (vì `isPublished=1` implies `isActive=1` per `publishProduct`). Tuy nhiên, `listActiveProducts` có thể thêm `retailPrice` vào rowToProduct để bot có thể show giá đúng.

- **QĐ8 — Validation markup reject**: `if (markupPct <= 0) throw` — markup âm hoặc bằng 0 đều reject (vì `retailPrice <= supplierPrice` ⟺ `markupPct <= 0` với supplierPrice dương, không đảm bảo margin dương). KHÔNG dùng post-computation compare. (Future: zero-markup pass-through / khuyến mãi giảm giá = special case riêng, scope 2.34.)

- **QĐ9 — Định nghĩa "admin lock" (nguồn truth publish state)**: "admin lock" = trạng thái `isPublished=0` ở DB, bất kể nguyên nhân (chưa publish bao giờ, hoặc đã `unpublishProduct`). Sync KHÔNG BAO GIỜ tự `publishProduct`/set `isActive=1`/`isPublished=1` — chỉ admin explicit mới chuyển product sang publish. Hệ quả: external product mới sync (`isPublished=0`, `isActive=0`) ở yên trạng thái đó cho tới khi admin gọi `publishProduct`. Sync chỉ refresh price/margin/stock/syncVersion.

## Acceptance Criteria

### AC1 — Admin set markup rule, hệ thống tính retailPrice
**Given** external products đã sync về (supplierPrice set)
**When** admin đặt markup theo **product, supplier, hoặc global** (tier `category` ĐÃ BỎ — products không có cột category, không có data nguồn; epic "category" deferred)
**Then** hệ thống tính `retailPrice = supplierPrice * (1 + markupPct/100)` với rounding rule
**And** lưu `expectedMargin = retailPrice - supplierPrice`
**And** khi product đã có rule áp dụng → `priceCredits` cập nhật = `retailPrice` (để checkout đọc đúng giá); khi CHƯA có rule → `priceCredits` giữ giá trị hiện tại (INSERT mới: `= supplierPrice` làm default an toàn, xem QĐ6)

### AC2 — External product được publish → hiển thị trong catalog
**Given** external product đã có markup (retailPrice set)
**When** admin publish product
**Then** `isPublished=1`, `isActive=1`
**And** product xuất hiện trong `listActiveProducts` / `/products` với `retailPrice` là giá hiển thị
**And** toggle hiện/ẩn supplier name DEFER sang story sau (chưa story nào — 2.30/2.31 — định nghĩa config `showSupplierName` sống ở đâu; không thêm schema speculative). 2.31 luôn trả catalog response như local product (không phân biệt supplier name display).

### AC3 — Supplier price/stock đổi → retail price cập nhật theo markup rule hiện tại
**Given** product đã publish với markup rule X
**When** sync nhận update supplierPrice mới từ supplier
**Then** hệ thống re-apply markup rule → tính lại `retailPrice` và `expectedMargin`
**And** `priceCredits` cập nhật theo retailPrice mới
**And** sync KHÔNG bao giờ động `isActive`/`isPublished` — admin lock (đã `unpublishProduct` hoặc set `isActive=0` qua `publishProduct`/`unpublishProduct`) được tôn trọng tuyệt đối; chỉ price/margin/syncVersion thay đổi

### AC4 — Markup không hợp lệ → reject với lỗi rõ ràng
**Given** admin lưu markup rule với `markupPct <= 0` (markup âm hoặc bằng 0 → `retailPrice <= supplierPrice`, không đảm bảo margin dương)
**When** admin lưu cấu hình
**Then** hệ thống reject với lỗi mô tả rõ "markupPct phải lớn hơn 0 (margin dương bắt buộc)"
**And** không lưu rule invalid vào DB
**And** validation là `if (markupPct <= 0) throw` — KHÔNG cần post-computation compare (vì `retailPrice <= supplierPrice` ⟺ `markupPct <= 0` với supplierPrice dương)

### AC5 — Backward-compat: local product không bị ảnh hưởng
**Given** toàn bộ thay đổi 2.31
**When** chạy full unit suite + thao tác product local (2.25-2.28)
**Then** local product (`source='local'`, supplier cột null) hành vi KHÔNG đổi
**And** `listActiveProducts` vẫn trả local product `isActive=1` không cần `isPublished`

## Tasks / Subtasks

- [x] **T1 — Schema: `markupRules` table + `products` pricing cột + migration** (AC1, AC5)
  - [x] Thêm bảng `markupRules` vào `TABLES` (schema.js) camelCase (QĐ1) + index `idx_markup_supplier`, `idx_markup_product`.
  - [x] Thêm vào `products.columns`: `supplierPrice REAL`, `retailPrice REAL`, `expectedMargin REAL`, `isPublished INTEGER DEFAULT 0` (đều nullable — local product null, backward-compat).
  - [x] Bump `SCHEMA_VERSION = 13`.
  - [x] Tạo `src/lib/db/migrations/011-markup-rules.js` (**version 11**): guard `tableExists`/column-present, `ALTER products ADD COLUMN ...` nếu thiếu, `CREATE TABLE IF NOT EXISTS markupRules`. Đăng ký `migrations/index.js` (import `m011`, append vào array). ⚠️ **Review CRITICAL #A**: slot `010` ĐÃ bị chiếm bởi `010-vuz2-connection.js` (version 10) — KHÔNG dùng `010`/version 10 (collision → `MIGRATIONS.sort()` ambiguous, double/skip apply). Dùng `011`/version 11.
  - [x] **Backfill external product cũ (Review][Patch][MAJOR]**: `UPDATE products SET supplierPrice = priceCredits WHERE source='external_telegram_store' AND supplierPrice IS NULL`. Lý do: external product sync trước 2.31 giữ raw supplier price ở `priceCredits`; không backfill → `supplierPrice=NULL` → `publishProduct` validation fail, admin không publish được tới khi có sync mới. Backfill cho phép publish ngay sau migration.
  - [x] Verify local product (`source='local'`) không bị ảnh hưởng: `isPublished=null` → `listActiveProducts` vẫn trả khi `isActive=1`. Backfill chỉ động `source='external_telegram_store'` → local product KHÔNG bị chạm.

- [x] **T2 — `markupRulesRepo.js`** (AC1, AC4)
  - [x] `ROUNDING_RULES = ['none','ceil','floor','round']` (enum E8).
  - [x] `createMarkupRule(data)` — validate `markupPct > 0` (Review patch: markupPct ≤ 0 → reject), `roundingRule` ∈ enum, ít nhất 1 scope (supplierId/productId) hoặc global (tất cả null = global fallback).
  - [x] `listMarkupRules()`, `getMarkupRuleById(id)`, `updateMarkupRule(id, data)`, `deleteMarkupRule(id)`.
  - [x] `findApplicableRule(productId, supplierId)` — lookup theo thứ tự ưu tiên: **product-level → supplier-level → global** (tier `category` ĐÃ BỎ — products không có cột category, xem Review patch CRITICAL #2); trả rule đầu tiên khớp hoặc null.
  - [x] Export qua `src/lib/db/index.js`.

- [x] **T3 — `src/lib/store/markupEngine.js`** (AC1, AC3, AC4, QĐ3-5)
  - [x] `calculateRetailPrice(supplierPrice, markupPct, roundingRule)` — pure function, validate `markupPct > 0` (throw nếu ≤ 0), apply rounding. Kể cả `roundingRule='none'` PHẢI round tối thiểu 6 decimal (`Math.round(n*1e6)/1e6`) để tránh BP-6 float drift.
  - [x] `applyMarkupToProduct(productId, db?)` — lookup rule + tính retail+margin + UPDATE products `retailPrice`/`expectedMargin`/`priceCredits` PHẢI trong CÙNG 1 transaction (lookup không tách khỏi write). Nhận `db?` adapter optional: khi gọi từ trong `upsertExternalProduct` (đã trong transaction) → nest inline, KHÔNG mở transaction mới (pattern E7). KHÔNG động `isActive`/`isPublished`.
  - [x] `publishProduct(productId)` — validate pricing set (`supplierPrice`+`retailPrice` set, `retailPrice > 0`), SET `isPublished=1 AND isActive=1` (giữ invariant isPublished⇒isActive).
  - [x] `unpublishProduct(productId)` — SET `isPublished=0 AND isActive=0`.
  - [x] `getEffectivePrice(product)` — trả `retailPrice ?? priceCredits` (safe fallback cho catalog display).

- [x] **T4 — Tích hợp `catalogSync.js`** (AC3, QĐ6)
  - [x] `upsertExternalProduct` UPDATE path: chỉ ghi `supplierPrice = normalized.priceCredits` (+ name/description/stock/syncVersion/lastSyncedAt). **KHÔNG ghi `priceCredits` trực tiếp** — `priceCredits` chỉ được set bởi `applyMarkupToProduct`.
  - [x] INSERT path: thêm `supplierPrice = Number(normalized.priceCredits ?? 0)`. Giữ `isActive=0`, `isPublished=0` (gate tới khi admin publish). ⚠️ **Review MAJOR #D**: INSERT PHẢI set `priceCredits = supplierPrice` làm initial default (KHÔNG bỏ trống — cột `REAL NOT NULL`, bỏ trống → default 0 → nếu product bị mua trước khi apply markup, checkout charge 0). `applyMarkupToProduct` sẽ overwrite `priceCredits` khi rule được apply. Rule "UPDATE chỉ ghi supplierPrice, giữ priceCredits cũ" CHỈ áp cho UPDATE path (đã có row), KHÔNG áp cho INSERT row mới.
  - [x] Trong CÙNG transaction của upsert: nếu product đã có applicable rule (`findApplicableRule`) → gọi `applyMarkupToProduct(productId, db)` inline (pass `db` adapter — KHÔNG mở transaction mới, pattern E7). Nếu không có rule → chỉ ghi `supplierPrice`, giữ `priceCredits` cũ.
  - [x] ⚠️ **Quyết định thiết kế (mọi path: poll + webhook)**: `upsertExternalProduct` **KHÔNG BAO GIỜ** ghi `isActive` hay `isPublished` của existing product. Publish/unpublish CHỈ qua `publishProduct`/`unpublishProduct` (admin explicit). Đặc biệt: `applyWebhookEvent` → `upsertExternalProduct` — dù `webhookAdapter.normalizeProduct` có field `isActive`, UPDATE statement TUYỆT ĐỐI không include `isActive`/`isPublished`. Document rõ trong code comment + thêm test guard.

- [x] **T5 — API routes** (AC1, AC2, AC4)
  - [x] `src/app/api/store/markup-rules/route.js` — GET (list) + POST (create, validate). Admin-only (`requireAdmin`).
  - [x] `src/app/api/store/markup-rules/[id]/route.js` — GET/PUT/DELETE. Admin-only.
  - [x] `src/app/api/store/suppliers/[id]/products/route.js` (hoặc `src/app/api/store/products/[id]/publish/route.js`) — POST `?action=publish` / `?action=unpublish` + POST `?action=apply-markup`. Admin-only.
  - [x] Sửa `src/app/api/store/products/route.js` (GET public): thêm `retailPrice` vào response; external product ẩn `supplierSourceId` nếu `showSupplierName=false` trong settings.

- [x] **T6 — `productsRepo.js`** (AC2, AC5)
  - [x] `rowToProduct`: thêm `supplierPrice`, `retailPrice`, `expectedMargin`, `isPublished` vào output.
  - [x] `listActiveProducts`: KHÔNG thay đổi query (isActive=1 đủ — publishProduct đảm bảo isActive=1 khi isPublished=1). Nhưng thêm comment giải thích invariant.
  - [x] `listExternalProducts(supplierId?)` — list external products (published + unpublished) cho admin view.
  - [x] **Enforce invariant isPublished⇒isActive** (Review CRITICAL #4): `updateProduct` PHẢI reject thay đổi `isActive` trên external product (`source='external_telegram_store'`) → bắt buộc admin dùng `publishProduct`/`unpublishProduct` thay vì set `isActive` trực tiếp. Tránh state lệch (`isPublished=1` nhưng `isActive=0`). Local product không bị ràng buộc này.
    - ⚠️ **Guard PHẢI scoped narrowly** (Review][Patch][MAJOR] integration): chỉ check `if (data.isActive !== undefined && existing.source === EXTERNAL_SOURCE) throw`. `existing` đã được fetch sẵn (`productsRepo.js:158`). Story 2.28 admin CRUD gọi `updateProduct` với `isActive` trên **local** product — guard sai phạm vi (không check source) sẽ vỡ 2.28. Import `EXTERNAL_SOURCE` từ `catalogSync.js` hoặc define constant chung.

- [x] **T7 — Tests** (AC1-AC5)
  - [x] `tests/unit/markupRulesRepo.test.js` (mới): create/validate/enum guard, priority lookup (product > supplier > global — KHÔNG có category tier), updateRule, deleteRule.
  - [x] `tests/unit/markupEngine.test.js` (mới): `calculateRetailPrice` pure function (rounding rules, `markupPct <= 0` reject, BP-6 6-decimal round kể cả `roundingRule='none'`, edge cases); `applyMarkupToProduct` inline-transaction (pass `db` adapter, không nest); `publishProduct` validate pricing + invariant isPublished⇒isActive; `publishProduct` **error-path** (supplierPrice=NULL hoặc retailPrice=NULL → reject); `unpublishProduct`; `getEffectivePrice` (`retailPrice ?? priceCredits` fallback).
  - [x] `tests/unit/catalogSync-markup.test.js` (mới): upsertExternalProduct stores `supplierPrice` (UPDATE path KHÔNG ghi `priceCredits` trực tiếp); INSERT path set `priceCredits = supplierPrice` initial (không để 0); sync re-applies markup inline nếu rule exists; **guard test**: sync (poll + `applyWebhookEvent`) KHÔNG BAO GIỜ đổi `isActive`/`isPublished` của existing product kể cả khi webhook event mang `isActive`.
  - [x] `tests/unit/markup-migration.test.js` (mới hoặc trong markupRulesRepo): migration 011 backfill `supplierPrice=priceCredits` cho external product cũ (`source='external_telegram_store' AND supplierPrice IS NULL`).
  - [x] **AC2 e2e** (Review][Patch][MAJOR] coverage gap): sau `publishProduct(productId)` → `listActiveProducts`/GET `/products` trả product đó VỚI (a) product xuất hiện, (b) `retailPrice` là giá hiển thị, (c) `priceCredits === retailPrice` (invariant checkout↔display). Đây là test end-to-end của AC2, không chỉ unit `applyMarkupToProduct`.
  - [x] **AC3 end-state** (Review][Patch][MINOR]): product đã `unpublishProduct` → sau khi sync nhận price update → vẫn `isPublished=0, isActive=0` (vắng khỏi `/products`), chỉ `supplierPrice`/`retailPrice` thay đổi. Assert observable state, không chỉ UPDATE statement.
  - [x] **Regression (AC5)**: local product không bị ảnh hưởng bởi markup tables; `listActiveProducts` vẫn trả local `isActive=1` khi `isPublished=null`; `createProduct` local không cần markup cột.

## Dev Notes

### Ràng buộc bắt buộc

- **Backward-compat (AC5)**: `products.supplierPrice/retailPrice/expectedMargin/isPublished` đều nullable. Local product: tất cả null. `listActiveProducts` WHERE `isActive=1` — KHÔNG thêm `isPublished IS NOT NULL` hay `source='local'` vào filter (sẽ phá local product hiện tại). Invariant: `publishProduct` SET `isActive=1`, nên filter `isActive=1` đủ cho cả hai loại.
- **`priceCredits` = giá checkout** (`storeCheckout.js` đọc `priceCredits` để trừ credit). Sau `applyMarkupToProduct`, `priceCredits = retailPrice`. Không bao giờ để `priceCredits` = supplierPrice cho external product đã publish.
- **Pure function `calculateRetailPrice`** (QĐ3): không DB, dễ test, không side effect. Hàm này tách khỏi DB layer để có thể test isolated.
- **Sync không override admin publish state** (QĐ6 + AC3 cuối): `upsertExternalProduct` chỉ UPDATE `supplierPrice/retailPrice/expectedMargin/priceCredits/syncVersion/lastSyncedAt`. KHÔNG SET `isActive` hay `isPublished`. Admin explicit action (`publishProduct`/`unpublishProduct`) là nguồn truth duy nhất cho publish state.
- **Transaction pattern**: `applyMarkupToProduct` và `publishProduct` dùng `db.transaction()` (better-sqlite3 sync). KHÔNG nest transaction trong transaction. Nếu cần gọi từ bên trong `upsertExternalProduct` (đã trong transaction) → pass `db` adapter optional như pattern `recordCreditTxnWithAdapter` (E7).
- **Scope guard**: KHÔNG đụng `storeCheckout.js`, billing, routing. 2.31 chỉ markup + publish display gate. Vendor checkout margin guardrails = 2.32 concern.
- **2.30 review findings open**: story 2.30 đang ở `review` với nhiều patch/decision chưa xử lý. Story 2.31 KHÔNG phụ thuộc vào những patch đó (markup là layer mới không conflict với các file 2.30 đang pending). Tuy nhiên nếu 2.30 patches được apply trước → verify `catalogSync.js` vẫn tương thích.

### Schema 2.31 thêm

```sql
-- markupRules table (mới) — KHÔNG có cột category (tier category bị bỏ khỏi MVP,
-- products không có cột category để bind — xem Review Findings CRITICAL #2)
id TEXT PRIMARY KEY, supplierId TEXT, productId TEXT,
markupPct REAL NOT NULL, roundingRule TEXT DEFAULT 'none',
isActive INTEGER DEFAULT 1, createdAt TEXT, updatedAt TEXT
-- Index: idx_markup_supplier(supplierId), idx_markup_product(productId)

-- products: thêm cột (nullable, backward-compat)
supplierPrice REAL       -- giá gốc supplier (persist riêng để re-apply markup)
retailPrice REAL         -- giá bán sau markup
expectedMargin REAL      -- retailPrice - supplierPrice
isPublished INTEGER DEFAULT 0  -- 1 = admin đã publish, 0 = ẩn (gate 2.31)
```

### Priority lookup cho markup rule

```
product-level:  markupRules WHERE productId = ?  AND isActive=1
supplier-level: markupRules WHERE supplierId = ? AND productId IS NULL AND isActive=1
global:         markupRules WHERE supplierId IS NULL AND productId IS NULL AND isActive=1
```

Lấy rule đầu tiên theo thứ tự trên. Nếu không có rule nào → không apply markup (product không publish được cho tới khi admin set rule). **Tier `category` bị bỏ** (Review Findings CRITICAL #2): `products` không có cột `category` để bind, category-level rule không bao giờ match được. Epic AC1 nhắc "supplier, category, hoặc product" nhưng category không có data nguồn ở MVP — defer tới khi có taxonomy.

### Files sẽ chạm

- `src/lib/db/schema.js` — MODIFY (+markupRules, +4 cột products, bump SCHEMA_VERSION 13)
- `src/lib/db/migrations/011-markup-rules.js` — NEW (version 11 — slot 010 đã bị `010-vuz2-connection.js` chiếm, xem Review Findings CRITICAL)
- `src/lib/db/migrations/index.js` — MODIFY (đăng ký m011)
- `src/lib/db/repos/markupRulesRepo.js` — NEW
- `src/lib/db/repos/productsRepo.js` — MODIFY (rowToProduct + listExternalProducts + updateProduct isActive guard source-scoped)
- `src/lib/db/index.js` — MODIFY (export markupRulesRepo)
- `src/lib/store/markupEngine.js` — NEW
- `src/lib/store/catalogSync.js` — MODIFY (upsert stores supplierPrice, re-applies markup inline)
- `src/app/api/store/markup-rules/route.js` — NEW
- `src/app/api/store/markup-rules/[id]/route.js` — NEW
- `src/app/api/store/products/[id]/publish/route.js` — NEW (hoặc action param trên [id] route)
- `src/app/api/store/products/route.js` — MODIFY (thêm retailPrice vào response)
- `tests/unit/markupRulesRepo.test.js` — NEW
- `tests/unit/markupEngine.test.js` — NEW
- `tests/unit/catalogSync-markup.test.js` — NEW
- `tests/unit/markup-migration.test.js` — NEW (backfill verify)

### KHÔNG được chạm (scope guard)

- `src/lib/store/storeCheckout.js` — checkout/billing là 2.32+
- `src/sse/services/auth.js` — routing không liên quan
- Flow local product 2.25-2.28 — chỉ thêm cột nullable, KHÔNG đổi hành vi

### Testing standards

- Vitest từ `tests/`: `cd tests && npm test -- unit/<file>.test.js` (alias `@/`→`src/`, deps `/tmp/node_modules`)
- Setup giống `supplierSourcesRepo.test.js`: temp `DATA_DIR`, `STORE_ENC_KEY`, `delete global._dbAdapter`, `vi.resetModules()`, `await getAdapter()`
- `markupEngine.test.js`: test `calculateRetailPrice` pure function trước (no DB), sau đó integration tests với real DB

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-2.31] — AC gốc BDD
- [Source: _bmad-output/planning-artifacts/architecture-store.md:69-81] — D1 schema sản phẩm, E8 enum tập trung
- [Source: _bmad-output/planning-artifacts/architecture-store.md:192-215] — E1-E12 enforcement rules, process patterns
- [Source: docs/stories/2-30-external-telegram-store-sources-catalog-sync.md#QĐ7] — External product isActive=0 gate tới 2.31
- [Source: src/lib/db/schema.js:276-302] — products columns hiện tại
- [Source: src/lib/store/catalogSync.js:25-74] — upsertExternalProduct current implementation
- [Source: src/lib/db/repos/productsRepo.js:11-33] — rowToProduct pattern
- [Source: src/lib/db/migrations/009-external-store-sources.js] — pattern migration guard + column-present

## Review Findings

_Design-phase review 2026-06-15 (story chưa implement). **Round 1**: Schema & Logic (✅), AC-Auditor (❌ 429), Integration-Hunter (❌ 503) → 7 patch áp dụng. **Round 2 (rerun trên spec đã sửa)**: AC-Auditor (✅) + Integration-Hunter (✅) — verify đủ 3 layer, code thật. Round 2 bắt thêm 7 patch (1 CRITICAL migration-collision chỉ thấy khi đọc code thật, 1 CRITICAL AC1-text-remnant, 5 MAJOR) + 1 decision (showSupplierName → defer). Tổng: 14 patch · 1 decision-resolved · 5 defer · 2 dismissed._

> ⚠️ **Các patch dưới sửa SPEC, không sửa code** (chưa có code). Dev PHẢI đọc trước khi implement.

**Patch — Round 2 (rerun, đã áp dụng vào spec — 2026-06-15):**

- [x] [Review][Patch][CRITICAL] Migration slot `010` ĐÃ BỊ CHIẾM — `migrations/index.js:13` đã import `010-vuz2-connection.js` (version 10). Tạo `010-markup-rules.js` version 10 → collision, `MIGRATIONS.sort()` ambiguous, runner apply/skip sai. **Fix T1**: dùng `011-markup-rules.js` version 11 (SCHEMA_VERSION 13 vẫn đúng — track logical schema state, không phải migration file number). Chỉ phát hiện được khi đọc code thật. (integration-hunter)
- [x] [Review][Patch][CRITICAL] AC1 text vẫn ghi "category" — mâu thuẫn QĐ1/T2/T7 (đã bỏ tier category ở round 1 nhưng quên sửa AC1 text). Test viết theo AC1 literal sẽ đòi category tier mà T2/T7 loại bỏ. **Fix**: AC1 viết lại "supplier hoặc product" + nêu rõ tier in-scope (product > supplier > global). (ac-auditor)
- [x] [Review][Patch][MAJOR] INSERT path gap — spec im lặng về `priceCredits` khi INSERT product mới chưa có rule. `priceCredits` là `REAL NOT NULL` → mặc định 0 → checkout charge 0 cho product mua trước khi markup apply. **Fix QĐ6/T4**: INSERT set `priceCredits = supplierPrice` initial (raw, tạm, non-publishable tới khi markup apply). (integration-hunter)
- [x] [Review][Patch][MAJOR] `updateProduct` isActive guard PHẢI scoped `source===EXTERNAL_SOURCE` narrowly — story 2.28 local admin CRUD gọi `updateProduct` với `isActive` trên local product, phải tiếp tục pass. Nếu guard không scope đúng source → vỡ 2.28. **Fix T6**: `if (data.isActive !== undefined && existing.source === EXTERNAL_SOURCE) throw` — local product KHÔNG bị ràng buộc. (integration-hunter)
- [x] [Review][Patch][MAJOR] QĐ8 boundary conflict — QĐ8 dùng `markupPct < 0` (strict, cho phép 0), QĐ3/AC4 dùng `markupPct <= 0` (reject 0). QĐ8 là remnant pre-patch. **Fix QĐ8**: thống nhất `markupPct <= 0 → reject`. (ac-auditor)
- [x] [Review][Patch][MAJOR] "Admin lock" định nghĩa lệch AC3↔QĐ5 — AC3 nói "set isActive=0 qua publishProduct/unpublishProduct" (publishProduct set isActive=1, không phải 0 → phrasing sai), QĐ5 nói lock = `unpublishProduct` only. Dev không phân biệt được lock = state `isPublished=0` (mọi nguyên nhân) hay chỉ là hành vi gọi `unpublishProduct`. **Fix QĐ8/AC3**: lock = `isPublished=0` do admin chủ động unpublish; product mới chưa publish (isPublished=0 initial) cũng không bị sync re-activate vì sync không bao giờ động isActive/isPublished. (ac-auditor)
- [x] [Review][Patch][MAJOR] Test thiếu cho AC2 e2e + `getEffectivePrice` + `publishProduct` error-path — T7 không có test gọi GET `/products` sau `publishProduct` để assert product xuất hiện + `retailPrice`=giá hiển thị + `priceCredits=retailPrice`; thiếu test `getEffectivePrice`; thiếu error-path `publishProduct` với `supplierPrice=NULL`. **Fix T7**: thêm 3 nhóm test. (ac-auditor)

**Decision (Round 2 — đã quyết):**

- [x] [Review][Decision] `showSupplierName` config KHÔNG có nguồn — AC2/T5 nhắc `showSupplierName` nhưng không story nào (2.30/2.31) định nghĩa nó sống ở đâu (schema? settings? supplier-level?), không có task tạo, không có test. **Quyết định: DEFER** — gỡ `showSupplierName` khỏi AC2/T5 của 2.31; luôn hiện retailPrice, không toggle supplier name. Lý do (best practice MVP): thêm schema speculative giờ vi phạm YAGNI + đúng cảnh báo "invent schema conflict với story sau"; 2.31 cũng không build UI toggle. Đẩy supplier-name visibility sang story sau khi có settings schema rõ ràng. (ac-auditor)

**Patch — Round 1 (đã áp dụng vào spec — 2026-06-15):**

- [x] [Review][Patch][CRITICAL] `applyMarkupToProduct` PHẢI chạy trong CÙNG `db.transaction()` với upsert — `syncSource` loop (catalogSync.js:119-126) upsert tất cả trong 1 transaction rồi return. Nếu re-apply markup ở transaction thứ 2 (sau commit) → giữa 2 lần write, `priceCredits` = raw supplier price (chưa markup) → `storeCheckout` đọc giá sai. **Fix QĐ4/QĐ6**: hoặc (a) UPDATE path KHÔNG ghi `priceCredits` (chỉ ghi `supplierPrice`), `priceCredits` chỉ được set bởi `applyMarkupToProduct` gọi inline trong cùng transaction (pass `db` adapter, pattern E7); hoặc (b) gộp markup-apply vào trong upsert transaction. (schema-logic)
- [x] [Review][Patch][CRITICAL] Tier `category` trong markup lookup KHÔNG thực thi được — `products` table không có cột `category` (schema.js confirmed: kind/name/description/priceCredits/deliveryMode/targetType/targetId/stock/isActive/source/supplier*/sync*). Category-level rule sẽ không bao giờ match (không có gì để bind). **Fix QĐ1**: chọn (a) BỎ tier category khỏi priority chain (chỉ product > supplier > global), hoặc (b) thêm cột `category TEXT` vào products + định nghĩa cách populate category cho external product khi sync. Khuyến nghị (a) cho MVP — epic AC1 nói "supplier, category, hoặc product" nhưng category không có data nguồn. (schema-logic)
- [x] [Review][Patch][MAJOR] Webhook path `applyWebhookEvent` → `upsertExternalProduct` cần explicit guard KHÔNG ghi `isActive`/`isPublished` — `webhookAdapter.normalizeProduct` có `isActive` field; nếu UPDATE statement của 2.31 lỡ include `isActive` → supplier webhook `isActive:false` bypass admin publish contract. **Fix QĐ6/T4**: ghi rõ UPDATE chỉ động `supplierPrice/retailPrice/expectedMargin/priceCredits/syncVersion/lastSyncedAt` — KHÔNG bao giờ `isActive`/`isPublished` ở mọi path (poll + webhook). (schema-logic)
- [x] [Review][Patch][MAJOR] Invariant "isPublished=1 ⇒ isActive=1" không được enforce — `updateProduct` (productsRepo.js:214-217) nhận `isActive` cho mọi product kể cả external. Admin set `isActive=0` trên product đã publish → biến mất khỏi catalog nhưng `isPublished=1` vẫn true (state lệch). **Fix QĐ5/QĐ7**: hoặc (a) CHECK constraint `CHECK (isPublished=0 OR isActive=1)`, hoặc (b) `updateProduct` reject thay đổi `isActive` trên external product → bắt buộc dùng `publishProduct`/`unpublishProduct`. Định nghĩa rõ "admin lock" (AC3) = cơ chế nào. (schema-logic)
- [x] [Review][Patch][MAJOR] Migration 010 cần backfill `supplierPrice` cho external product 2.30 cũ — product đã sync trước 2.31 có `supplierPrice=NULL`, `retailPrice=NULL` → `publishProduct` validation fail, admin KHÔNG publish được tới khi có sync mới. **Fix T1**: migration backfill `UPDATE products SET supplierPrice=priceCredits WHERE source='external_telegram_store' AND supplierPrice IS NULL` (priceCredits hiện giữ raw supplier price pre-2.31). Thêm operational note. (schema-logic)
- [x] [Review][Patch][MINOR] AC4 validation đơn giản hóa thành `markupPct > 0 required` — `retailPrice <= supplierPrice` ⟺ `markupPct <= 0` (với supplierPrice dương). Điều kiện "retailPrice <= supplierPrice" luôn đúng khi markupPct<=0 → check thực chất là `markupPct <= 0`. **Fix QĐ3/QĐ8/AC4**: validation = `if (markupPct <= 0) throw`. Nếu cần zero-markup (pass-through) → special case riêng. Bỏ post-computation comparison gây nhầm lẫn. (schema-logic)
- [x] [Review][Patch][MINOR] Markup rule 4-tier lookup PHẢI chạy trong cùng transaction với `applyMarkupToProduct` UPDATE — tránh rule bị edit giữa các lần read (WAL: read không block write). **Fix QĐ4**: gói lookup + UPDATE trong 1 `BEGIN/COMMIT`, hoặc 1 SQL query với ORDER BY priority. (schema-logic)

**Deferred:**

- [x] [Review][Defer] `expectedMargin` stored derived value có thể stale [QĐ2] — chấp nhận là "last-applied margin snapshot"; mọi path động `retailPrice`/`supplierPrice` đều re-run `applyMarkupToProduct` nên đồng bộ. Có thể compute on-read ở API layer nếu muốn — defer optimization.
- [x] [Review][Defer] BP-6 float REAL cho retailPrice/margin [QĐ3] — known project-wide limitation (creditTransactions cũng REAL). Mitigate: `calculateRetailPrice` luôn round tối thiểu 6 decimal kể cả `roundingRule='none'`; checkout dùng `Math.round(n*1e6)/1e6`. Không đổi sang integer ở Epic I (architecture-store.md:187).
- [x] [Review][Defer] Thiếu `publishedAt`/`publishedBy` audit trail [QĐ5] — nice-to-have cho store tài chính; defer story-level, không block MVP.
- [x] [Review][Defer] Purchasable-status khi `stock=0` lúc sync (epic AC3 "purchasable status") [QĐ6] — sync hiện không set `isActive=0` khi stock về 0; thuộc stock-handling, ngoài core markup/publish của 2.31. Defer: chốt stock→purchasable gate ở 2.32 (vendor checkout) hoặc story stock riêng.
- [x] [Review][Defer] Unpublished product + sync price update → `expectedMargin`/`retailPrice` stale tới khi republish [QĐ6] — sync có thể skip `applyMarkupToProduct` cho product unpublished (không lợi ích re-price hàng ẩn); margin stale chỉ lộ khi admin republish (lúc đó admin re-apply markup là tự nhiên). Edge-case, defer; nếu cần chính xác tuyệt đối → `publishProduct` luôn re-apply markup trước khi set isPublished=1.

**Dismissed (2):** `unpublishProduct` vs in-flight checkout (by-design — checkout đọc snapshot nhất quán trong transaction, hành vi đúng, chỉ cần document không thêm re-check); markup lookup race "có thể insert rule giữa reads" (SQLite single-writer serialise — đã cover bởi patch transaction-wrap ở trên).

---

### Post-Implementation Code Review (2026-06-15)

_Adversarial 3-layer review (Blind Hunter, Edge Case Hunter, Acceptance Auditor) trên commit `c910732`. Tất cả finding đã verify trực tiếp trên code thật. Verification độc lập: 42 test mới pass; migration chain apply sạch tới #11; full suite 1540 pass / 24 skip / 2 fail (`xai-oauth-service.test.js` — pre-existing test-pollution, pass khi chạy riêng, KHÔNG liên quan 2.31). Triage: 5 patch · 6 defer · 6 dismissed (false-positive/noise)._

**Patch (fixable, unambiguous):**

- [x] [Review][Patch][MAJOR] `unpublishProduct` thiếu source guard — có thể deactivate LOCAL product [`src/lib/store/markupEngine.js:143-153`] — `unpublishProduct` chỉ check `product` tồn tại rồi `SET isPublished=0, isActive=0` cho BẤT KỲ product nào. `publishProduct` được guard ngầm bởi `supplierPrice == null` throw, nhưng `unpublishProduct` không có guard tương đương. Route `publish/route.js:53-54` cũng không check source. Gọi `POST /products/{localId}/publish?action=unpublish` trên product `source='local'` → local product biến mất khỏi catalog (vi phạm AC5 backward-compat). Fix: thêm `if (product.source !== EXTERNAL_SOURCE) throw` trong `unpublishProduct`.
- [x] [Review][Patch][MAJOR] `updateProduct` cho phép ghi `priceCredits` trực tiếp trên external product — phá invariant `priceCredits === retailPrice` [`src/lib/db/repos/productsRepo.js:223-229`] — guard `isActive` (scoped `EXTERNAL_SOURCE`) đã có, nhưng `priceCredits` thì KHÔNG. `updateProduct(extId, { priceCredits: 0 })` ghi đè giá markup; `storeCheckout` đọc `priceCredits` → charge sai (vd 0) trong khi `retailPrice` giữ giá cũ → checkout↔display lệch. Vi phạm QĐ4/QĐ6 ("priceCredits CHỈ set bởi applyMarkupToProduct"). Fix: thêm guard `if (data.priceCredits !== undefined && existing.source === EXTERNAL_SOURCE) throw` (scope giống isActive — local 2.28 không vỡ).
- [x] [Review][Patch][MAJOR] Input numeric non-finite (Infinity/NaN) lọt qua mọi tầng validation [`src/lib/db/repos/markupRulesRepo.js:22-27`, `src/lib/store/markupEngine.js:22-28`, `src/lib/store/catalogSync.js:38`] — `markupPct <= 0` và `supplierPrice < 0` không bắt `Infinity` (`Infinity <= 0` = false). `markupPct=Infinity` → `retailPrice=Infinity` → `priceCredits=Infinity` → checkout `balance < Infinity` luôn true → INSUFFICIENT_CREDITS vĩnh viễn. Tương tự `catalogSync.js:38` `Number(normalized.priceCredits ?? 0)` cho `NaN` khi supplier gửi chuỗi non-numeric (`?? 0` chỉ bắt null/undefined). Fix: thêm `Number.isFinite()` vào `validateRuleData` + `calculateRetailPrice` (cả markupPct và supplierPrice) + sanitize coercion ở `upsertExternalProduct`.
- [x] [Review][Patch][MINOR] `findApplicableRule` — cả 3 query `LIMIT 1` thiếu `ORDER BY` → chọn rule non-deterministic [`src/lib/db/repos/markupRulesRepo.js:118-137`] — khi có >1 active rule cùng tier (schema không có UNIQUE constraint chặn), `LIMIT 1` không `ORDER BY` trả row theo thứ tự B-tree (đổi sau VACUUM/checkpoint). Markup áp dụng đổi không lý do giữa các lần sync. Fix: thêm `ORDER BY createdAt ASC` (hoặc DESC) cho cả 3 tier query để chốt determinism.
- [x] [Review][Patch][MINOR] T7 AC3 end-state test thiếu assert vắng khỏi catalog [`tests/unit/catalogSync-markup.test.js`] — test "poll sync does not re-activate a published-then-unpublished product" assert `isPublished=0/isActive=0` trên DB row nhưng KHÔNG gọi `listActiveProducts()` để xác nhận product vắng khỏi `/products`. T7 yêu cầu rõ "vắng khỏi `/products`" như observable state. Fix: thêm assert `listActiveProducts()` không chứa product sau sync.

**Deferred (real, không actionable bây giờ / ngoài scope):**

- [x] [Review][Defer] Rule có cả `productId`+`supplierId` khớp product-level cross-supplier [`src/lib/db/repos/markupRulesRepo.js:118-122`] — query product-level `WHERE productId = ?` không lọc supplierId; rule `{productId:'p1', supplierId:'s2'}` khớp lookup p1 từ supplier bất kỳ. Tuy nhiên code khớp ĐÚNG spec (QĐ lookup dòng 207-211 định nghĩa product-level = `WHERE productId = ?`). productId là unique nên rule keyed theo productId vốn đã supplier-specific; kịch bản cross-supplier đòi admin nhập data vô nghĩa. Defer: hardening data-entry, không phải bug vs spec.
- [x] [Review][Defer] `supplierPrice=0` → `retailPrice=0` + lỗi publish gây hiểu nhầm [`src/lib/store/markupEngine.js:22,127`] — `supplierPrice<0` reject nhưng `=0` pass; `markupPct>0` cho `retailPrice=0`; `applyMarkupToProduct` ghi `priceCredits=0`; `publishProduct` chặn nhưng báo "retailPrice chưa set — cần applyMarkupToProduct" (sai, đã apply). Cần product-decision: free external product có hợp lệ không? Defer chờ quyết định, sau đó hoặc reject `supplierPrice=0` hoặc tách error message.
- [x] [Review][Defer] `getEffectivePrice` trả `undefined` khi cả `retailPrice`+`priceCredits` null [`src/lib/store/markupEngine.js:162-164`] — `product.retailPrice ?? product.priceCredits` trả undefined nếu cả hai null/absent. Hiện KHÔNG có caller nào trong `src/` (dead code). Defer: thêm fallback `?? 0` hoặc throw khi có consumer thật.
- [x] [Review][Defer] `listMarkupRules` không pagination [`src/lib/db/repos/markupRulesRepo.js:57-60`] — `SELECT * ... ORDER BY createdAt DESC` không LIMIT. Khớp pattern repo hiện có (listAllProducts cũng vậy); scale concern. Defer: thêm pagination khi rule table lớn.
- [x] [Review][Defer] Deactivate markup rule không reprice product đã áp dụng [`src/lib/db/repos/markupRulesRepo.js` updateMarkupRule] — `updateMarkupRule(id,{isActive:false})` chỉ đổi row rule; product đã priced giữ `priceCredits`/`retailPrice` cũ tới sync sau (lúc đó `findApplicableRule` trả null → skip reprice). Cùng class với defer "stale margin" của design-review. Defer: cascade-reprice là enhancement, không block MVP.
- [x] [Review][Defer] `isPublished` trả boolean `false` thay vì `null` cho local product [`src/lib/db/repos/productsRepo.js:39`] — 3 field pricing sibling (`supplierPrice/retailPrice/expectedMargin`) trả `null` cho local, nhưng `isPublished` trả `false` (lệch spec "local product null"). Tuy nhiên `false` defensible hơn cho flag publish, và đổi sang null có thể vỡ consumer mong boolean (`isActive` cũng theo pattern boolean). Test AC5 đã accept `false`. Defer: consistency note, đổi có rủi ro contract.

**Dismissed (6 — false-positive / noise):**

- `updateMarkupRule`/`deleteMarkupRule` "TOCTOU read-then-write" (blind) — SAI: sau `await getAdapter()` mọi call `db.get`/`db.run` là đồng bộ better-sqlite3, KHÔNG có `await` xen giữa → single-threaded Node không thể interleave. Không có race window.
- `colExists` "SQL injection qua `PRAGMA table_info(${table})`" (blind) — SAI: SQLite KHÔNG cho bind table-name trong PRAGMA (param không hợp lệ cú pháp); `table` hardcoded `"products"`, không có user input. Không khai thác được.
- `apply-markup` route "TOCTOU giữa applyMarkupToProduct + getProductById" (blind) — noise: single-writer serialise; re-read sau commit là behavior chấp nhận được cho admin action.
- `publishProduct` thiếu source check (blind) — đã guard ngầm: local product `supplierPrice == null` → throw trước khi publish. (unpublishProduct mới là vấn đề thật — xem patch.)
- Double `findApplicableRule` call trong upsert (auditor) — noise: pre-check + internal lookup chạy cùng transaction, an toàn; chỉ là micro-inefficiency.

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (BMAD Create Story workflow) → claude-opus-4-8 (BMAD Dev Story implementation)

### Debug Log References

- **Adapter transaction signature**: `adapter.transaction(fn)` đã tự-gọi `fn` (xem `betterSqliteAdapter.js:51` → `db.transaction(fn)()`). Lần đầu viết `publishProduct`/`unpublishProduct` với `db.transaction(...)()` thừa `()` → fixed (gọi không kèm `()`).
- **E7 inline-transaction**: `applyMarkupToProduct` ban đầu là `async` → khi gọi inline từ `upsertExternalProduct` (sync transaction), promise rejection không abort transaction ngoài. Refactor thành `applyMarkupWithAdapter(productId, adapter, wrapTransaction)` đồng bộ (mirror `recordCreditTxnWithAdapter`) — nhánh inline sync để DB error abort được outer transaction.
- **Test isolation**: 4 test file đầu thiếu `vi.resetModules()` trong `beforeEach` → "database connection is not open" (module-cached adapter trỏ tới connection đã đóng). Thêm `vi.resetModules()` cho cả 4.
- **Stale test 2.30**: `catalogSync.test.js` re-sync test assert `priceCredits=15` (hành vi pre-2.31). QĐ6 đổi contract: UPDATE path chỉ ghi `supplierPrice`, `priceCredits` chỉ do `applyMarkupToProduct` set → cập nhật assert thành `supplierPrice=15, priceCredits=10` (giữ INSERT default khi không có rule).

### Completion Notes List

- **T1 Schema**: `markupRules` table + 4 cột pricing (`supplierPrice/retailPrice/expectedMargin/isPublished`) vào `products`, bump `SCHEMA_VERSION=13`, migration `011-markup-rules.js` (version 11 — slot 010 đã bị `010-vuz2-connection.js` chiếm) với backfill `supplierPrice=priceCredits` cho external product cũ.
- **T2 markupRulesRepo**: `ROUNDING_RULES` enum, CRUD + `findApplicableRule(db, productId, supplierId)` priority lookup product→supplier→global (KHÔNG có category tier).
- **T3 markupEngine**: `calculateRetailPrice` pure (markupPct≤0 reject, BP-6 6-decimal round kể cả `none`); `applyMarkupToProduct` E7 dual-mode (inline sync + standalone async); `publishProduct`/`unpublishProduct` (invariant isPublished⇒isActive); `getEffectivePrice`.
- **T4 catalogSync**: UPDATE path chỉ ghi `supplierPrice`; INSERT set `priceCredits=supplierPrice` initial; inline `applyMarkupToProduct` cùng transaction nếu có rule; KHÔNG bao giờ ghi `isActive`/`isPublished` ở mọi path (poll + webhook).
- **T6 productsRepo**: `rowToProduct` thêm 4 pricing fields; `listExternalProducts`; `updateProduct` guard reject `isActive` trên external product (scoped narrowly `source===EXTERNAL_SOURCE` — local 2.28 không vỡ). `EXTERNAL_SOURCE` định nghĩa cục bộ để tránh circular import.
- **T5 API routes**: markup-rules CRUD (GET/POST + GET/PUT/DELETE), product publish route (`?action=publish|unpublish|apply-markup`), tất cả `requireAdmin`. Public products route đã tự trả `retailPrice` qua `rowToProduct` (không cần sửa). `showSupplierName` DEFER theo Review Decision.
- **T7 Tests**: 4 file mới — 42 test pass. Cover AC1-AC5 + AC2 e2e (publish→listActiveProducts với `priceCredits===retailPrice`) + getEffectivePrice + publishProduct error-path + sync no-touch guard (poll + webhook) + migration backfill + AC5 regression (local + updateProduct guard scope).
- **Verification**: full suite **1542 passed, 24 skipped, 0 failed**. (Lưu ý: `xai-oauth-service.test.js` flaky do test pollution song song — pass khi chạy riêng + pass ở lần full thứ hai, không liên quan 2.31.)

### File List

- `src/lib/db/schema.js` — MODIFY (markupRules table, +4 cột products, bump SCHEMA_VERSION 13)
- `src/lib/db/migrations/011-markup-rules.js` — NEW (version 11, ALTER + CREATE + backfill)
- `src/lib/db/migrations/index.js` — MODIFY (đăng ký m011)
- `src/lib/db/repos/markupRulesRepo.js` — NEW
- `src/lib/db/repos/productsRepo.js` — MODIFY (rowToProduct pricing fields, listExternalProducts, updateProduct isActive guard, EXTERNAL_SOURCE)
- `src/lib/db/index.js` — MODIFY (export markupRulesRepo + listExternalProducts/listAllProducts/updateProduct/deleteProduct)
- `src/lib/store/markupEngine.js` — NEW
- `src/lib/store/catalogSync.js` — MODIFY (upsert stores supplierPrice, inline markup re-apply, no isActive/isPublished write)
- `src/app/api/store/markup-rules/route.js` — NEW
- `src/app/api/store/markup-rules/[id]/route.js` — NEW
- `src/app/api/store/products/[id]/publish/route.js` — NEW
- `tests/unit/markupRulesRepo.test.js` — NEW
- `tests/unit/markupEngine.test.js` — NEW
- `tests/unit/catalogSync-markup.test.js` — NEW
- `tests/unit/markup-migration.test.js` — NEW
- `tests/unit/catalogSync.test.js` — MODIFY (cập nhật re-sync assert theo QĐ6: priceCredits không bị UPDATE path ghi)

### Change Log

| Date | Change |
|------|--------|
| 2026-06-15 | Story 2.31 implemented — markupRules table + products pricing cột (T1), markupRulesRepo (T2), markupEngine pure+DB (T3), catalogSync markup integration (T4), admin API routes (T5), productsRepo pricing+guard (T6), 4 test files 42 tests (T7). Full suite 1542 pass. Status → review. |

