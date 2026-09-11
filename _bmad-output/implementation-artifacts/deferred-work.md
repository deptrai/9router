## Deferred from: code review of story-1.3 (2026-09-10) — ALL RESOLVED 2026-09-11

- RESOLVED: Deceptive "idempotency" test refactored to assert explicit delegation of `TelegramUserDto` in `users.controller.spec.ts`.
- RESOLVED: Deprecated `/api/auth/me` with clear JSDoc tag pointing to `/api/users/me` for client consolidation.

## Deferred from: code review of 1-4-quan-ly-so-cai-tai-chinh-kep-bao-ve-so-du-khong-am.md (2026-09-10) — ALL RESOLVED 2026-09-11

- RESOLVED: Added `currency` column (default 'VND') and created indexes on `ledgerTransactions` (`wallet_id`, `reference_id`, `created_at`) in `schema.ts` and migration `0006_clean_namor.sql`.
- RESOLVED: Implemented held-balance ledger operations (`hold`, `releaseHold`, `captureHold`) in `LedgerService` with unit test coverage.

## Deferred from: code review of 2-3-tao-hoa-don-nap-tien-tu-dong-qua-bitcart-crypto (2026-09-10) — ALL RESOLVED 2026-09-11

- RESOLVED: `convertVndToUsd` rounds up (ceil) to prevent underpayment with epsilon guard; rate fallback configured.
- RESOLVED: Polling timeout extended to 200 ticks (~10 minutes) for on-chain crypto in Mini App.
- RESOLVED: Added `MAX_TOPUP_VND` ceiling validation across API and Mini App.
- RESOLVED: Deleted dead code `resolveSettlement` from `BitcartService`.
- RESOLVED: Hardened `normalizeContract` with `0x` auto-prefixing on 40-char hex addresses.
- RESOLVED: Dynamic QR code display for crypto `payAddress` in Mini App.

## Deferred from: code review of story-2.4 (2026-09-11) — ALL RESOLVED 2026-09-11

- RESOLVED: `isResourceLocked` quorum requires every vote-against be `ResourceLockedError`; mixed votes fail-open.
- RESOLVED: `withLock` propagates Redlock `signal` into routine; `*Core` checks `signal.aborted` before wallet credit.
- RESOLVED: `redlock` pinned exact `5.0.0-beta.2`; ships own types.
- RESOLVED: Added `payment_lock_acquired` (lockWaitMs) + `payment_lock_contention` structured logs.
- RESOLVED: Redlock on single-node kept with consistent `using()` and auto-extension.

## Deferred from: code review of 3-1-hien-thi-danh-muc-san-pham-trang-thai-kho-trong-mini-app.md (2026-09-11) — ALL RESOLVED 2026-09-11

- RESOLVED: AES-256-GCM credential encryption at rest implemented in `@repo/database` (`encryptCredential`/`decryptCredential`) with unit tests and backfilled database rows.
- RESOLVED: Database indexes added on foreign keys and filter targets (`product_inventory.product_id`, `product_id + status`, `products.supplier_source_id`, `products.is_active + category`) in migration `0006_clean_namor.sql`.
- RESOLVED: Added database constraints `CHECK (price >= 0)` on products, `CHECK (status IN (...))` on inventory, and `CHECK (markup_percentage >= 0)` on supplier sources.
- RESOLVED: Realtime synchronization of wallet balance in `BalanceHeader` via tab focus, custom event `wallet_refresh`, and background interval polling.
- RESOLVED: Wrapped seed operations in `db.transaction(...)` with encrypted credential insertions.

## Deferred from: code review of 3-2-quan-ly-kho-credential-noi-bo-cap-phat-chong-ban-qua.md (2026-09-11)

- `markDefective.reason` parameter accepted but never persisted — schema has no `reason`/`defect_reason` column and no logging infrastructure in place. Needs schema migration or audit table.

## Deferred from: code review of 4-1-dong-bo-gia-von-quy-tac-bien-loi-nhuan-tu-dong (2026-09-11)

- **Orders idempotency key không scoped theo user** — `OrdersService.getOrderByIdempotencyKey` (`orders.service.ts:85-92,108-115`) lọc chỉ theo `idempotency_key` (global unique trong `orders` schema). User khác replay một key đã biết sẽ nhận được order + `deliveredCredential` của chủ order. Fix hướng: thêm `eq(orders.userId, userRecord.id)` vào cả 2 điểm check, hoặc scope unique theo `(user_id, idempotency_key)`.
- **Checkout đọc `products` không `FOR UPDATE`** — `orders.service.ts:126-134` đọc product trong tx READ COMMITTED mà không khóa row; `price-sync` (Story 4.1) có thể đổi `price`/`isActive` giữa lúc đọc và lúc debit/insert order. Cân nhắc `.for('update')` hoặc chấp nhận snapshot-read là đủ (giá dùng nhất quán trong tx).
- **`ledger.recordTransaction` idempotency không wallet-scoped + retry 23505 trong tx đã abort** — `ledger.service.ts:336-342` check chỉ theo `idempotencyKey`; catch 23505 ở `388-397` gọi `runner.select` trong transaction đã bị Postgres abort → sẽ throw tiếp trên DB thật (spec chỉ mock). Cần retry sau abort hoặc re-check ngoài tx.
- **`captureHold` vi phạm ledger invariant** — `ledger.service.ts:295-302` ghi `amount` âm nhưng `balanceAfter == balanceBefore` (hold giảm `heldBalance`, không đổi `balance`). Khi hold/capture được wire vào flow thật (Story 4.2+), cần sửa semantics dòng ledger.
- **Spec test 23505 chỉ mock** — `ledger.service.spec.ts` race test không phản ánh transaction-abort thật của Postgres; cần integration test hoặc restructure retry ngoài tx.
- **`PRICE_SYNC_FAILED` alert type chưa được emit** — enum + DB CHECK đã có (`admin_alerts`), nhưng fetch-failure chỉ tạo item `FAILED` + log. Cần design chống spam (ví dụ: chỉ insert alert khi cùng product fail N lần liên tiếp, hoặc tổng hợp 1 alert per run) trước khi bật — defer đến khi cần observability thật.
- [ ] [Review][Defer] **`.env` không được load khi `pnpm dev`** — `main.ts` đọc `process.env.PORT` trước bất kỳ dotenv/ConfigModule nào; chạy trần → `TELEGRAM_BOT_TOKEN` missing (mọi route auth → 500 `CONFIG_TELEGRAM_BOT_TOKEN_MISSING`), PORT rơi về default 3001. Workaround: `set -a; source ./.env; set +a; pnpm dev`. Đề xuất: thêm `import 'dotenv/config'` đầu `main.ts` hoặc `ConfigModule.forRoot`. [main.ts:14] — deferred, pre-existing dev-env gap (phát hiện trong live E2E verify Story 4.1)
