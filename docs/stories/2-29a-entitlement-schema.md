---
baseline_commit: 05814b977bce46b4200a0209aec6252725fc109c
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture-store.md
  - docs/stories/2-28-admin-product-inventory-order-management.md
  - docs/stories/2-26-telegram-checkout-orders.md
  - src/lib/db/schema.js
  - src/lib/db/migrate.js
  - src/lib/db/migrations/006-store-v2.js
  - src/lib/db/repos/connectionsRepo.js
  - src/lib/store/storeCheckout.js
  - src/lib/telegram/router.js
  - src/sse/services/auth.js
---

# Story 2.29a — Entitlement Schema & Self-Connect Lifecycle

Status: ready-for-dev

## Story

As a buyer,
I want sau khi mua một product `user_self_connect`, hệ thống tạo entitlement và cho tôi connect provider account của mình,
so that quyền dùng provider tôi mua được ghi nhận (lifecycle pending → active) TRƯỚC khi routing áp dụng ở story 2.29b.

## Bối cảnh và quyết định architecture

> **Split từ story 2.29 gốc** (`architecture-store.md` §D7, 2026-06-11). 2.29a = **schema + lifecycle, KHÔNG đụng routing engine**. Routing (`getProviderCredentials` opts.userId + M2–M7) là 2.29b — review riêng, security test cross-user bắt buộc.

### Hiện trạng code (verified tại baseline 05814b9)

- **`providerConnections`** (`src/lib/db/schema.js:30-48`): cột `id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt`. **CHƯA có `ownerUserId`** → hiện là shared admin pool, không user-aware.
- **`connectionsRepo.js`**: `createProviderConnection(data)` (line 91) insert qua `upsert()` (line 46) — chỉ map các cột cố định, field lạ gói vào `data` JSON. `getProviderConnections({provider, isActive})` (line 59) là read dùng bởi routing.
- **`getProviderCredentials`** (`src/sse/services/auth.js:22`) gọi `getProviderConnections({provider, isActive:true})` (line 76) — **KHÔNG tham chiếu `ownerUserId`**. ⇒ thêm cột nullable hoàn toàn không phá routing hiện tại (M1 thỏa mãn ở mức schema).
- **`user_self_connect`**: chỉ là enum value (`productsRepo.js:6` `DELIVERY_MODES`, schema comment `schema.js:277`). Trong `storeCheckout.js:150-168`, order `user_self_connect` rơi vào nhánh "không phải instant" → giữ nguyên `paid`, **không làm gì thêm**. Đây chính là chỗ 2.29a chèn việc tạo entitlement.
- **`entitlements`**: CHƯA tồn tại (grep `entitlement` trong `src/` chỉ trúng `usage/fetcher.js` không liên quan).
- **`SCHEMA_VERSION = 10`** (`schema.js:2`). Migration mới nhất `007-context-safe-combos.js` (version 7). `syncSchemaFromTables` (`migrate.js:87-117`) **auto-ALTER thêm cột/bảng thiếu** (additive); migration versioned chạy TRƯỚC sync. Pattern chuẩn (story 2.27, `006-store-v2.js`): vừa thêm vào declarative `TABLES` (cho DB mới) vừa viết migration guard `tableExists` (cho DB cũ).

### Quyết định architecture (chốt cho story này)

- **QĐ1 — `entitlements` table** (theo `architecture-store.md` §D1, điều chỉnh tên cột cho khớp codebase camelCase):
  ```
  entitlements  id, userId, productId, provider, status, providerConnectionId,
                routePolicy, expiresAt, note, createdAt, updatedAt
  ```
  - `status` ∈ `pending_connection | active | expired | revoked` (lifecycle).
  - `routePolicy` ∈ `owned_only | prefer_owned` (2.29b dùng; 2.29a chỉ lưu, default `prefer_owned`).
  - `provider` = provider mà entitlement cấp quyền — **derive từ product** (xem QĐ3).
  - `expiresAt` nullable (null = không hết hạn); 2.29b resolve lazy.
- **QĐ2 — `providerConnections` thêm 2 cột nullable** (M1, F7 guard):
  - `ownerUserId TEXT` (default NULL = shared pool — **tuyệt đối backward-compat**, connection cũ `null` không đổi routing).
  - `entitlementId TEXT` (default NULL = link tới entitlement khi user connect).
  - ⚠️ `connectionsRepo` map cột cố định, KHÔNG để 2 field này lọt vào `data` JSON — phải thêm vào `connToRow`/`rowToConn` (xem T4).
- **QĐ3 — provider của entitlement lấy từ product**: product `user_self_connect` set `targetType="provider"` và `targetId=<providerId>` (vd `"anthropic"`). Khi order paid, entitlement.provider = orderItem.targetId. Nếu product thiếu targetId → **fail-safe**: vẫn tạo entitlement với `provider=null` + note cảnh báo, admin bổ sung sau (KHÔNG block checkout — tiền đã trừ atomic).
- **QĐ4 — điểm tạo entitlement**: trong `storeCheckout` txn, sau khi order→paid, nếu `deliveryMode==="user_self_connect"` → insert entitlement `pending_connection` **trong CÙNG transaction** (atomic với order, E1/E9). Trả `entitlementId` trong checkout result.
- **QĐ5 — kích hoạt (activate)**: hàm `linkConnectionToEntitlement(connectionId, entitlementId, userId)` — set `providerConnections.ownerUserId + entitlementId`, set `entitlements.providerConnectionId + status='active'`, trong 1 transaction. Story 2.29a cung cấp hàm + 1 API route để dashboard/bot gọi; UI connect-flow đầy đủ có thể hoàn thiện ở 2.29b nhưng **lifecycle phải chạy được end-to-end** trong 2.29a (test bằng repo trực tiếp).
- **QĐ6 — KHÔNG đụng `getProviderCredentials`**. Tuyệt đối không sửa `src/sse/services/auth.js` trong story này (đó là 2.29b, E11 + M2–M7). Nếu thấy cần sửa routing để "test cho chạy" → DỪNG, đó là dấu hiệu lệch scope.

## Acceptance Criteria

### AC1 — Order `user_self_connect` paid → tạo entitlement `pending_connection` (FR46)
**Given** product có `deliveryMode="user_self_connect"`
**When** `storeCheckout` hoàn tất order → `paid`
**Then** hệ thống tạo 1 row `entitlements` status=`pending_connection`, gắn `userId`, `productId`, `provider` (derive từ product.targetId), `routePolicy` (từ product hoặc default `prefer_owned`)
**And** việc tạo entitlement nằm TRONG cùng transaction với order (atomic — không có "order paid nhưng thiếu entitlement")
**And** checkout result trả `entitlementId`.

### AC2 — Link connection → entitlement active (FR46)
**Given** một entitlement `pending_connection` và user tạo/chọn một `providerConnection` cho provider tương ứng
**When** gọi `linkConnectionToEntitlement(connectionId, entitlementId, userId)`
**Then** `providerConnections.ownerUserId = userId` và `entitlementId` được set
**And** `entitlements.providerConnectionId` được set và `status` chuyển `active`
**And** thao tác atomic (1 transaction); reject nếu entitlement không thuộc `userId` hoặc không ở trạng thái `pending_connection`.

### AC3 — Migration backward-compat tuyệt đối (M1, F7)
**Given** schema migration chạy trên DB hiện có (có providerConnections cũ)
**When** thêm cột `providerConnections.ownerUserId` + `entitlementId`
**Then** cả hai default `NULL` — connection admin pool cũ (`ownerUserId=null`) KHÔNG đổi
**And** `getProviderConnections`/`getProviderCredentials` chạy y hệt trước (routing không đổi hành vi)
**And** migration chạy được trên cả DB mới (qua declarative TABLES) lẫn DB cũ (qua migration guard `tableExists`).

### AC4 — entitlementsRepo CRUD + lifecycle
**Given** repo `entitlementsRepo.js`
**When** dev gọi các hàm repo
**Then** có: `createEntitlementSync(adapter, data)`, `getEntitlementById(id)`, `listEntitlementsByUser(userId, {status?})`, `linkConnectionToEntitlement(...)`, `transitionEntitlement(id, toStatus)` (state machine), `getEntitlementsByProduct(productId)`
**And** state machine chặn transition phi pháp (vd `revoked → active`).

### AC5 — Hướng dẫn user connect (FR46, NFR9)
**Given** order `user_self_connect` vừa paid trên Telegram
**When** bot gửi xác nhận mua thành công
**Then** message nêu rõ trạng thái "cần kết nối account" + hướng dẫn ngắn (deep-link dashboard hoặc lệnh tiếp theo)
**And** `/orders` hiển thị entitlement `pending_connection` là trạng thái cần hành động (không phải "đã giao").

### AC6 — KHÔNG regression routing
**Given** toàn bộ thay đổi 2.29a
**When** chạy full unit suite
**Then** không có test routing/connection nào fail; `getProviderCredentials` không bị sửa
**And** test mới chứng minh connection cũ (`ownerUserId=null`) vẫn nằm trong pool như trước.

## Tasks / Subtasks

- [ ] **T1 — Schema: `entitlements` table + `providerConnections` 2 cột + bump SCHEMA_VERSION + migration** (AC1, AC3)
  - [ ] Thêm bảng `entitlements` vào `TABLES` (`schema.js`) đúng naming camelCase (QĐ1) + index `idx_entitlements_user`, `idx_entitlements_product`, `idx_entitlements_status`.
  - [ ] Thêm `ownerUserId: "TEXT"` và `entitlementId: "TEXT"` vào `providerConnections.columns` (nullable, KHÔNG default non-null — F7).
  - [ ] Bump `SCHEMA_VERSION = 11`.
  - [ ] Tạo `src/lib/db/migrations/008-entitlements.js` (version 8): guard `tableExists`, `ALTER TABLE providerConnections ADD COLUMN ownerUserId TEXT` + `entitlementId TEXT` nếu thiếu; `CREATE TABLE IF NOT EXISTS entitlements`. Đăng ký vào `migrations/index.js`.
  - [ ] Verify thứ tự: migration versioned chạy trước `syncSchemaFromTables` (đọc `migrate.js`); cả 2 đường (DB mới/cũ) đều có schema đúng.

- [ ] **T2 — `entitlementsRepo.js`** (AC4)
  - [ ] `ENTITLEMENT_STATUSES = ["pending_connection","active","expired","revoked"]` + `ROUTE_POLICIES = ["owned_only","prefer_owned"]` + `canTransition(from,to)`.
  - [ ] `createEntitlementSync(adapter, {userId, productId, provider, routePolicy?, expiresAt?, note?, id?, now?})` — insert status `pending_connection`; SYNC để gọi trong checkout txn.
  - [ ] `getEntitlementById(id)`, `listEntitlementsByUser(userId, {status?,limit?,offset?})`, `getEntitlementsByProduct(productId)`.
  - [ ] `transitionEntitlement(id, toStatus, {note?})` — async, state-machine validated.
  - [ ] Export qua `src/lib/db/index.js`.

- [ ] **T3 — `storeCheckout`: tạo entitlement khi `user_self_connect` paid** (AC1)
  - [ ] Trong txn, sau order→paid: nếu `product.deliveryMode === "user_self_connect"` → `createEntitlementSync(adapter, {...})` với `provider = product.targetId` (QĐ3 fail-safe nếu null).
  - [ ] Trả `entitlementId` trong checkout result (giống pattern `reservedCredentialIds`).
  - [ ] KHÔNG đụng nhánh `instant`/`admin_fulfill`.

- [ ] **T4 — `connectionsRepo`: map 2 cột mới + `linkConnectionToEntitlement`** (AC2)
  - [ ] Cập nhật `connToRow`/`rowToConn` (line 13-44) để `ownerUserId`/`entitlementId` là cột cố định (KHÔNG lọt vào `data` JSON). Cập nhật `upsert()` INSERT/UPDATE statement (line 48-56) thêm 2 cột.
  - [ ] `linkConnectionToEntitlement(connectionId, entitlementId, userId)` (QĐ5): 1 transaction — set connection.ownerUserId+entitlementId, set entitlement.providerConnectionId + status='active'; validate ownership + trạng thái `pending_connection`.
  - [ ] ⚠️ Giữ nguyên hành vi `createProviderConnection` mặc định: connection admin tạo KHÔNG set ownerUserId (vẫn shared).

- [ ] **T5 — API route + bot guidance** (AC2, AC5)
  - [ ] `src/app/api/store/entitlements/route.js` — GET (listEntitlementsByUser của user đang đăng nhập) + POST link `{entitlementId, connectionId}` → `linkConnectionToEntitlement`. Auth: user session (KHÔNG phải admin-only — đây là self-serve). `force-dynamic`.
  - [ ] `router.js`: sau khi `storeCheckout` trả order `user_self_connect`, message xác nhận nêu "cần kết nối account" + hướng dẫn (AC5). `/orders` label entitlement pending.

- [ ] **T6 — Tests** (AC1–AC6)
  - [ ] `tests/unit/entitlementsRepo.test.js` (mới): create/get/list/transition + state-machine guard.
  - [ ] `tests/unit/storeCheckout.test.js` (mở rộng): order `user_self_connect` → tạo entitlement `pending_connection`, trả entitlementId, atomic (rollback khi lỗi).
  - [ ] `tests/unit/connectionsRepo.test.js` (mở rộng hoặc mới): `linkConnectionToEntitlement` happy path + guard (sai owner, sai trạng thái); **regression: connection `ownerUserId=null` vẫn trả trong `getProviderConnections`** (AC6/M1).
  - [ ] Verify `getProviderCredentials` (auth.js) KHÔNG đổi (grep diff = 0 dòng trong file đó).

## Dev Notes

### Ràng buộc bắt buộc (từ `architecture-store.md` E1–E12)

- **E1/E9**: tạo entitlement trong cùng `db.transaction()` với order→paid (atomic). KHÔNG tạo entitlement ở transaction riêng sau commit (race: order paid nhưng crash trước khi tạo entitlement).
- **E3 (cross-user guard — quan trọng cho 2.29b nhưng đặt nền ở đây)**: `ownerUserId` strict match `=== userId`; **null ≠ match** một user cụ thể. 2.29a chỉ ghi `ownerUserId`, nhưng đừng viết logic nào coi `null` là "thuộc về user X".
- **E6**: schema mới qua declarative `TABLES` + bump `SCHEMA_VERSION`; migration thủ công CHỈ cho ALTER cột bảng cũ (guard `tableExists`, không destructive).
- **E8**: enum (`ENTITLEMENT_STATUSES`, `ROUTE_POLICIES`) khai báo 1 nơi trong repo, import — không hardcode string rải rác.
- **Anti-pattern F7**: TUYỆT ĐỐI không để `ownerUserId` default non-null → sẽ làm admin pool cũ biến mất khỏi routing.

### Files sẽ chạm

- `src/lib/db/schema.js` — MODIFY: +bảng `entitlements`, +2 cột `providerConnections`, bump VERSION.
- `src/lib/db/migrations/008-entitlements.js` — NEW.
- `src/lib/db/migrations/index.js` — MODIFY: đăng ký m008.
- `src/lib/db/repos/entitlementsRepo.js` — NEW.
- `src/lib/db/repos/connectionsRepo.js` — MODIFY: map 2 cột + `linkConnectionToEntitlement`.
- `src/lib/db/index.js` — MODIFY: export entitlementsRepo.
- `src/lib/store/storeCheckout.js` — MODIFY: tạo entitlement cho `user_self_connect`.
- `src/lib/telegram/router.js` — MODIFY: guidance message + /orders label.
- `src/app/api/store/entitlements/route.js` — NEW.
- `tests/unit/entitlementsRepo.test.js` — NEW.
- `tests/unit/storeCheckout.test.js`, `tests/unit/connectionsRepo.test.js` — MODIFY/NEW.

### KHÔNG được chạm (scope guard)

- `src/sse/services/auth.js` (`getProviderCredentials`) — đây là 2.29b. Sửa file này = lệch scope, DỪNG lại.

### Testing standards

- Unit test bằng vitest, chạy từ `tests/`: `cd tests && npm test -- unit/<file>.test.js` (alias `@/`→`src/`). Test deps ở `/tmp/node_modules`.
- Pattern setup (xem `tests/unit/storeCheckout.test.js`): temp `DATA_DIR` mkdtemp, `process.env.STORE_ENC_KEY`, `delete global._dbAdapter`, `vi.resetModules()`, `await getAdapter()` để init+migrate; cleanup ở `afterEach`.
- SYNC repo helper (gọi trong txn) test qua `adapter.transaction(() => {...})`.

### Project Structure Notes

- ⚠️ **Tên thực tế ≠ tài liệu kiến trúc**: `architecture-store.md` viết bảng inventory là `inventoryItems` và env `STORE_CRED_KEY`, nhưng code 2.27 đã ship là `productCredentials` + `STORE_ENC_KEY`. Story 2.29a độc lập với credential nhưng dev cần biết để khỏi nhầm khi đọc doc kiến trúc.
- Story file đặt ở `docs/stories/` (theo `sprint-status.yaml` `story_location` + vị trí 2-26/2-27/2-28), KHÔNG ở `_bmad-output/implementation-artifacts/`.

### References

- [Source: _bmad-output/planning-artifacts/architecture-store.md#D7] — entitlement routing, M1–M7, tách 2.29a/2.29b.
- [Source: _bmad-output/planning-artifacts/architecture-store.md#D1] — entitlements table shape.
- [Source: _bmad-output/planning-artifacts/epics.md#Story-2.29a] — AC gốc BDD.
- [Source: src/lib/db/schema.js:30-48] — providerConnections hiện tại (chưa có ownerUserId).
- [Source: src/lib/db/repos/connectionsRepo.js:46-154] — upsert + createProviderConnection.
- [Source: src/lib/db/migrations/006-store-v2.js] — pattern migration guard `tableExists`.
- [Source: src/lib/store/storeCheckout.js:150-171] — nơi user_self_connect hiện chỉ giữ paid.
- [Source: src/sse/services/auth.js:22-91] — getProviderCredentials (KHÔNG chạm ở 2.29a).

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
