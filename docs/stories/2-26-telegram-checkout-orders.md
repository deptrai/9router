---
baseline_commit: 2810d81
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - docs/stories/2-25-telegram-user-linking-product-catalog.md
  - docs/stories/2-18-plan-purchase-flow.md
  - docs/stories/2-4-credit-billing.md
---

# Story 2.26 — Telegram Checkout & Orders

Status: done

## Story

**As a** Telegram user đã xem catalog,
**I want** bấm nút mua → xác nhận → bị trừ credits và nhận đơn hàng,
**so that** tôi hoàn tất mua sản phẩm ngay trong Telegram, an toàn và không bị tính tiền 2 lần.

## Bối cảnh và quyết định architecture

Story 2.25 đã dựng nền: `products` catalog, bot infra (botClient/router/webhook), `/start` + `/products`, và nút mua `buy:<productId>` (callback stub "sẽ sớm ra mắt"). Story 2.26 biến nút đó thành **checkout thật**: xác nhận → trừ credit nguyên tử → tạo order + line items → giao tự động (instant) hoặc chờ admin (admin_fulfill).

### Hiện trạng code (verified)

- **Nút mua đã có nhưng là stub** (`router.js`): `buy:<productId>` callback chỉ trả "Chức năng mua hàng sẽ sớm ra mắt". → 2.26 thay bằng confirm + execute flow.
- **Credit ledger bất biến**: `recordCreditTxn({ userId, type, amount, refId, idempotencyKey, note }, adapter)` (creditLedgerRepo) — nhận adapter để chạy **trong** transaction của caller (sync path, không mở nested txn). `amount < 0` = debit. Reuse cho debit `store_purchase`.
- **`addCredits`/`getUserById`** (usersRepo): `users.creditsBalance` là nguồn số dư. Balance gate đọc trực tiếp trong txn.
- **`db.transaction(fn)`** (driver adapter): bọc nhiều statement commit-hoặc-rollback. SQLite WAL, đồng bộ. → dùng cho atomic sale.
- **`syncSchemaFromTables`** (migrate.js): tự `CREATE TABLE` cho table mới trong `schema.js` TABLES. → thêm `orders` + `orderItems`, bump SCHEMA_VERSION.
- **`getProductById` / `listActiveProducts`** (productsRepo, story 2.25): reuse cho confirm + validate.
- **Telegram callback_query**: `answerCallbackQuery(id)` dừng spinner client. Update đến qua webhook đã verify secret (2.25 AC4) → `from.id` trusted.

### Scope 2.26 (CHỈ story này)

Làm:
1. `orders` + `orderItems` table schema (state machine + line-item snapshot).
2. `ordersRepo.js`: insert + transition (state-machine guard) + truy vấn.
3. `storeCheckout.js`: domain helper mua hàng nguyên tử (stock → debit → order → fulfill).
4. Bot buy flow: `buy:` → confirm card, `buyc:` → execute, `buyx` → cancel.

KHÔNG làm (để story sau):
- Fulfillment thực cho `admin_fulfill` / credential delivery (2.27 — order chỉ dừng ở `paid`).
- `/orders` history UI đầy đủ (chỉ cần message xác nhận có mã đơn; list repo có sẵn cho sau).
- Self-connect entitlement (2.29).
- Refund/cancel flow qua bot (state machine hỗ trợ `refunded`/`cancelled` nhưng chưa expose command).
- `9router_plan` activation (plan product → reuse `purchasePlanForUser` ở story sau; 2.26 chỉ trừ credit + tạo order).

## Acceptance Criteria

**AC1 — Buy confirmation**
- WHEN user bấm nút mua (`buy:<productId>`)
- AND product còn active + còn hàng
- THEN bot hiện card xác nhận: tên sản phẩm, giá credits, nút ✅ Xác nhận / ❌ Hủy
- AND product inactive HOẶC hết hàng → message "không khả dụng"/"hết hàng", KHÔNG hiện nút xác nhận

**AC2 — Atomic credit debit + order creation**
- WHEN user bấm ✅ Xác nhận (`buyc:<productId>`)
- AND số dư đủ + còn hàng
- THEN trong **một** transaction: trừ stock (nếu có giới hạn) + ghi debit `store_purchase` lên ledger + tạo order (`status=paid`) + order line items (snapshot tên/giá/kind/delivery)
- AND bất kỳ bước nào fail → rollback toàn bộ (không trừ tiền dở, không giảm stock dở)

**AC3 — Delivery mode routing**
- WHEN order được tạo thành công
- AND `deliveryMode=instant` → transition `paid → fulfilled`, báo "Đã giao"
- AND `deliveryMode ∈ {admin_fulfill, user_self_connect}` → giữ `paid`, báo "đang chờ xử lý"

**AC4 — Idempotency (NFR7)**
- WHEN cùng một callback được Telegram gửi lại (retry) HOẶC user bấm xác nhận 2 lần
- THEN chỉ tạo 1 order, chỉ trừ tiền 1 lần
- AND lần sau trả về order đã tồn tại (`alreadyProcessed=true`), báo "đã xử lý trước đó"

**AC5 — Checkout guards (no oversell, no overspend)**
- WHEN stock không đủ → `OUT_OF_STOCK`, không trừ tiền
- WHEN số dư < tổng giá → `INSUFFICIENT_CREDITS`, không giảm stock
- WHEN product không tồn tại/inactive → `PRODUCT_NOT_FOUND`/`INACTIVE`
- WHEN quantity không hợp lệ (< 1 hoặc không nguyên) → `INVALID_QUANTITY`
- AND mọi lỗi trả message ngắn, KHÔNG leak stack trace

**AC6 — Order state machine**
- WHEN transition order
- THEN chỉ cho phép forward hợp lệ: `pending→{paid,cancelled,failed}`, `paid→{fulfilled,cancelled,failed,refunded}`, `fulfilled→{refunded}`; terminal states không có outgoing
- AND transition tới cùng status hiện tại = no-op idempotent; transition bất hợp lệ → throw

**AC7 — Tests**
- WHEN dev hoàn tất: tests cover happy path (debit + order + instant fulfill), oversell guard, insufficient credits (+ stock rollback), missing/inactive product, invalid quantity, idempotent replay (charge once), admin_fulfill giữ `paid`

## Decision Points (đã chốt)

- **D1 — Atomicity boundary**: (A) **một `db.transaction()` bọc cả sale** (stock + debit + order + items + instant fulfill). `recordCreditTxn` + `insertOrderWithItems` + `transitionOrder` nhận adapter để chạy sync trong txn, KHÔNG mở nested txn. **Chọn (A)** — đảm bảo all-or-nothing (AC2). `getAdapter().transaction()` đồng bộ (SQLite), không await bên trong.

- **D2 — Oversell safety**: (A) **conditional UPDATE** `SET stock = stock - ? WHERE id = ? AND stock >= ?` → kiểm `changes === 0` để bắt hết hàng. NULL stock = unlimited (skip decrement). **Chọn (A)** — guard ở DB-level, an toàn dưới đồng thời, không cần SELECT-then-UPDATE race.

- **D3 — Idempotency key**: order có `idempotencyKey` UNIQUE index. Bot tạo key `tg:<telegramId>:<productId>:<callbackQueryId>` — `callbackQueryId` ổn định qua Telegram retry cùng update. **Double-check trong txn** (`SELECT ... WHERE idempotencyKey`) để đóng race mà pre-check ngoài txn để hở. Replay → trả order cũ + `alreadyProcessed=true`.

- **D4 — Confirm step**: (A) **2-bước** `buy:` (confirm card) → `buyc:` (execute). **Chọn (A)** — tránh trừ tiền do bấm nhầm, cho user thấy giá trước khi commit. `buyx` = hủy.

## Tasks / Subtasks

### Part A — Orders schema + repo (AC2, AC6)

- [x] **A1**: Thêm `orders` table vào `schema.js` TABLES: `id PK, userId, status DEFAULT 'pending', source DEFAULT 'telegram', totalCredits REAL, deliveryMode, ledgerTxnId, idempotencyKey, note, createdAt, updatedAt`. Indexes: `idx_orders_user_ts(userId,createdAt)`, `idx_orders_status(status)`, UNIQUE `idx_orders_idempotency(idempotencyKey)`. Bump `SCHEMA_VERSION` 7→8.
- [x] **A2**: Thêm `orderItems` table: `id PK, orderId, productId, productName, kind, deliveryMode, targetType, targetId, unitCredits REAL, quantity DEFAULT 1, createdAt` (snapshot product fields). Index `idx_orderitems_order(orderId)`.
- [x] **A3**: `ordersRepo.js`: `ORDER_STATUSES`, `canTransition(from,to)` (ALLOWED_TRANSITIONS map), `insertOrderWithItems(adapter, order, items)` (chạy trong txn caller), `transitionOrder(id, to, {note, db})` (state-machine guard + idempotent no-op), `getOrderById`, `getOrderByIdempotencyKey`, `listOrdersByUser`. Export qua `db/index.js`.

### Part B — Checkout domain helper (AC2, AC4, AC5)

- [x] **B1**: `src/lib/store/storeCheckout.js` + `CheckoutError(code)` (PRODUCT_NOT_FOUND|INACTIVE|OUT_OF_STOCK|INSUFFICIENT_CREDITS|INVALID_QUANTITY).
- [x] **B2**: Pre-check idempotency ngoài txn (fast path) + recheck trong txn (đóng race).
- [x] **B3**: Trong `adapter.transaction()`: validate product → conditional stock decrement (D2) → balance gate → `recordCreditTxn` debit (`store_purchase`, amount âm, refId=orderId) → `insertOrderWithItems` (status=paid) → instant → `transitionOrder(fulfilled)`.

### Part C — Bot buy flow (AC1, AC3, AC4)

- [x] **C1**: `handleBuyConfirm(chatId, productId)` — `getProductById` → validate active+stock → card xác nhận (nút `buyc:<id>` / `buyx`).
- [x] **C2**: `handleBuyExecute(chatId, telegramId, productId, callbackQueryId)` — `getUserByTelegramId` → `storeCheckout` với `idempotencyKey=tg:<tg>:<pid>:<cqid>` → message thành công (mã đơn + trạng thái giao). `CheckoutError` → message map sẵn; lỗi khác → fallback + log.
- [x] **C3**: Router callback dispatch: `answerCallbackQuery(cq.id)` trước; `buyx`→hủy, `buyc:`→execute, `buy:`→confirm. Reorder để `buyc:` match trước `buy:`.

### Part D — Tests (AC7)

- [x] **D1**: `tests/unit/storeCheckout.test.js` — temp DATA_DIR + per-test adapter reset. Cover: happy path (debit 500, stock 5→3, instant→fulfilled), admin_fulfill giữ paid, oversell guard (no debit), insufficient credits (stock rollback), missing/inactive product, invalid quantity, idempotent replay (charge once, 1 order).

## Dev Notes

### Code hiện có cần reuse

**`recordCreditTxn(txn, adapter)`** (creditLedgerRepo) — truyền `adapter` (db trong txn) ở tham số 2 → chạy sync, KHÔNG mở nested transaction. `amount` âm = debit. `idempotencyKey` riêng cho ledger (`store:<orderId>`) khác với `orders.idempotencyKey` (callback dedup) — đừng nhầm 2 key.

**`adapter.transaction(fn)`** (driver) — đồng bộ. Bên trong CHỈ gọi sync (`adapter.get/run/all`, `insertOrderWithItems`, `transitionOrder({db: adapter})`). KHÔNG `await` trong fn.

**`transitionOrder`** — nhận `{db}` để nest trong txn caller (sync) hoặc tự `getAdapter()` (async) khi gọi ngoài. Instant fulfill gọi với `{db: adapter}`.

**`getProductById`** (productsRepo, 2.25) — confirm card. `isActive` lưu INTEGER → check `=== 1 || === true`.

### storeCheckout flow (D1 atomic)

```js
adapter.transaction(() => {
  // 1. in-txn idempotency recheck
  // 2. load+validate product (active)
  // 3. conditional stock decrement: WHERE stock >= qty → changes===0 ? OUT_OF_STOCK
  // 4. balance gate: creditsBalance < total ? INSUFFICIENT_CREDITS
  // 5. recordCreditTxn(debit, adapter)
  // 6. insertOrderWithItems(adapter, {status:'paid', ...}, [snapshot])
  // 7. instant ? transitionOrder(fulfilled, {db: adapter})
});
```
⚠️ Order tạo thẳng ở `paid` (không `pending→paid`) vì credit debit + order commit cùng txn — không có khoảng "chờ trả tiền" cho credit-paid sale. `pending` dành cho payment-gateway flow tương lai.

### Idempotency 2 lớp (D3)

- Pre-check ngoài txn: fast path replayed callback, tránh mở txn thừa.
- Recheck trong txn: `SELECT id FROM orders WHERE idempotencyKey = ?` — đóng race 2 callback đồng thời (UNIQUE index là backstop cuối, nhưng recheck cho UX trả order cũ thay vì throw constraint).

### Regression / scope guard

- KHÔNG đụng plan activation / `purchasePlanForUser` — `9router_plan` product chỉ trừ credit + tạo order ở 2.26; entitlement grant là story sau.
- KHÔNG đụng credit billing pipeline (2.4) — chỉ thêm txn type `store_purchase` qua API có sẵn.
- Telegram login (2.22) + catalog (2.25) không đổi; chỉ thay stub `buy:` callback.
- `admin_fulfill` orders dừng ở `paid` — fulfillment thực là 2.27.

### Testing note

Test pattern giống `storeCheckout.test.js` (đã viết): `fs.mkdtempSync` temp DATA_DIR, `vi.resetModules()` + re-import per test để bind adapter mới, `getAdapter()` force migrate. Seed user qua `createUser` + `addCredits`. Không mock DB — chạy SQLite thật trên temp dir để verify atomicity/rollback thật.

## References

- [Epics] `_bmad-output/planning-artifacts/epics.md` — Epic I (FR38–FR50), story 2.26 checkout, NFR7 (idempotency/anti-replay), NFR10 (reuse credit ledger)
- [Story 2.25] `docs/stories/2-25-telegram-user-linking-product-catalog.md` — products catalog, bot infra, `buy:` callback stub được thay
- [Story 2.18] `docs/stories/2-18-plan-purchase-flow.md` — `purchasePlanForUser` (story sau reuse cho 9router_plan product)
- [Story 2.4] `docs/stories/2-4-credit-billing.md` — credit ledger, `recordCreditTxn`, immutable txn model
- [Source] `src/lib/store/storeCheckout.js` — atomic checkout helper
- [Source] `src/lib/db/repos/ordersRepo.js` — orders state machine + repo
- [Source] `src/lib/telegram/router.js` — buy confirm/execute/cancel handlers
- [Source] `src/lib/db/repos/creditLedgerRepo.js` — `recordCreditTxn(txn, adapter)` sync-in-txn path
- [Source] `src/lib/db/schema.js` — `orders` + `orderItems` TABLES (SCHEMA_VERSION 8)

## Dev Agent Record

### Change Log
- 2026-06-11: Story created + implemented (→ done). Code: `orders` + `orderItems` tables trong `schema.js` (SCHEMA_VERSION 7→8, 3+1 indexes incl. UNIQUE idempotency), `src/lib/db/repos/ordersRepo.js` (state machine `canTransition`, `insertOrderWithItems`, `transitionOrder`, `getOrderById`, `getOrderByIdempotencyKey`, `listOrdersByUser`), `src/lib/store/storeCheckout.js` (atomic txn: stock decrement oversell-safe + ledger debit `store_purchase` + order/items + instant fulfill; `CheckoutError` 5 codes; idempotency 2 lớp), `src/lib/telegram/router.js` (buy confirm `buy:` → card, execute `buyc:` → checkout, cancel `buyx`; `answerCallbackQuery` dừng spinner; reorder `buyc:` trước `buy:`), exports qua `db/index.js`. Tests: `tests/unit/storeCheckout.test.js` (9 case: happy path + instant fulfill, admin_fulfill giữ paid, oversell, insufficient + stock rollback, missing, inactive, invalid quantity, idempotent replay). Verification: `storeCheckout.test.js` pass toàn bộ, Next.js build green (chỉ 1 pre-existing unrelated fail ở `embeddings.cloud.test.js`).
