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

## Deferred from: code review of 3-2-quan-ly-kho-credential-noi-bo-cap-phat-chong-ban-qua.md (2026-09-11) — ALL RESOLVED 2026-09-14

- RESOLVED: `markDefective.reason` ghi nhận audit log chi tiết qua `this.logger.warn` trong `InventoryService.markDefective` (`inventory.service.ts:245`).

## Deferred from: code review of 4-1-dong-bo-gia-von-quy-tac-bien-loi-nhuan-tu-dong (2026-09-11) — RESOLVED 2026-09-14

- RESOLVED: **Orders idempotency key scoped theo user** — `OrdersService.checkout` resolve user trước, `getOrderByIdempotencyKey(key, userId)` lọc theo `orders.userId`, và throw 409 `IDEMPOTENCY_KEY_COLLISION` nếu key thuộc về user khác (`orders.service.ts:130`). Unit test bảo đảm user khác không thể xem hoặc nhận credential của chủ order.
- RESOLVED: **Checkout đọc `products` với khóa `FOR UPDATE`** — `orders.service.ts:194` bổ sung `.for('update')` trong giao dịch database checkout, ngăn chặn triệt để race condition khi catalog sync hoặc admin sửa giá/trạng thái sản phẩm.
- RESOLVED: **`.env` tự động load tại entrypoint API** — `apps/api/src/main.ts` nạp tuần tự `apps/api/.env` và fallback root `.env` qua `dotenv.config({ path: ... })`, đồng thời root `.env` đã được đồng bộ với port 3201 và bot token hợp lệ.
- **`ledger.recordTransaction` idempotency không wallet-scoped + retry 23505 trong tx đã abort** — `ledger.service.ts:336-342` check chỉ theo `idempotencyKey`; catch 23505 ở `388-397` gọi `runner.select` trong transaction đã bị Postgres abort → sẽ throw tiếp trên DB thật (spec chỉ mock). Cần retry sau abort hoặc re-check ngoài tx.
- **`captureHold` vi phạm ledger invariant** — `ledger.service.ts:295-302` ghi `amount` âm nhưng `balanceAfter == balanceBefore` (hold giảm `heldBalance`, không đổi `balance`). Khi hold/capture được wire vào flow thật (Story 4.2+), cần sửa semantics dòng ledger.
- **Spec test 23505 chỉ mock** — `ledger.service.spec.ts` race test không phản ánh transaction-abort thật của Postgres; cần integration test hoặc restructure retry ngoài tx.
- **`PRICE_SYNC_FAILED` alert type chưa được emit** — enum + DB CHECK đã có (`admin_alerts`), nhưng fetch-failure chỉ tạo item `FAILED` + log. Cần design chống spam (ví dụ: chỉ insert alert khi cùng product fail N lần liên tiếp, hoặc tổng hợp 1 alert per run) trước khi bật — defer đến khi cần observability thật.

## Deferred from: code review of 4-2-dieu-phoi-nguon-hang-thong-minh (2026-09-12) — ALL RESOLVED 2026-09-12

- RESOLVED: Lock-lost-sau-commit không còn trả `ORDER_LOCK_CONFLICT` giả — catch branch query theo `idempotencyKey`, nếu order đã commit thì trả order + chạy `ensureJobForSourcingOrder` self-heal; chỉ 409 khi chắc chắn không có order. `orders.service.ts` catch + test "lock lost AFTER tx commit".
- RESOLVED: Supplier TOCTOU được chốt thành binding contract trong JSDoc `SOURCING_QUEUE_NAME` (`shared-types/dtos/index.ts`) — worker 4.3 phải discard job non-SOURCING, re-validate `is_active` + `config_credentials`, re-check `maxUpstreamCost`, và terminal failure → REFUNDED, không bao giờ để order kẹt SOURCING.
- RESOLVED: `products_sourcing_mode_valid` CHECK constraint thêm vào `schema.ts` + migration `0009_vengeful_lyja.sql`, đã apply live và verify reject `'external'`, accept `'EXTERNAL'`.
- RESOLVED: Margin guard trong checkout — `canSource` giờ yêu cầu `upstreamCost <= price` và `upstreamCost <= maxUpstreamCost` (khi có); `upstreamCost === null` không chặn. Vi phạm → `OUT_OF_STOCK`, không charge. 2 tests cover cả 2 nhánh.
- RESOLVED: In-flight guard — cùng user+product đã có order `PENDING|PAID|SOURCING` → `409 ORDER_IN_PROGRESS` trước khi debit (errorCode mới trong `CheckoutErrorDto` union + branch tiếng Việt trong `CheckoutModal`). Áp dụng mọi product, không chỉ EXTERNAL.
- RESOLVED: Orders page tự refresh — refetch on window `focus` + poll 5s chỉ khi có order `SOURCING`, cleanup đầy đủ (cancelled flag + removeEventListener + clearInterval).

## Deferred from: spec review of spec-6-2-backend-sync-engine-adapter-parser-queue (2026-09-13) — ALL RESOLVED 2026-09-14

- RESOLVED: Implemented Spec C (`spec-6-2-catalog-sync-orchestration-queue-worker.md`): `CatalogSyncQueueService`, `CatalogSyncService`, `CatalogSyncWorker`, and admin sync endpoints (`POST /api/admin/suppliers/:id/sync`, `GET /api/admin/suppliers/:id/sync-status`).

## Resolved from: code review of spec-6-2-catalog-sync-orchestration-queue-worker (2026-09-14)

All 5 deferred items resolved in the same session:

- ~~**Numbered sub-lists after price orphaned**~~ — FIXED: `groupProductBlocks` now appends price-less numbered fragments to the previous block instead of orphaning them. `catalog-parser.service.ts:70`
- ~~**No reconciliation for removed upstream products**~~ — FIXED: `syncSupplierCatalog` now marks products absent from latest scrape as `stock=0` via `notInArray` on `supplierProductId`. `catalog-sync.service.ts:162`
- ~~**Unbounded Redis queue operations can hang HTTP**~~ — FIXED: `enqueueSyncJob` wrapped in `withTimeout(5000ms)` following `SourcingQueueService` pattern; throws `ServiceUnavailableException` on timeout. `catalog-sync-queue.service.ts:88`
- ~~**Dual source of truth: `sync_interval_sec` column vs `configCredentials.syncIntervalSec`**~~ — FIXED: `syncIntervalSec` stripped from `configCredentials` before persist on both create and update paths. Column is now the sole source of truth. `suppliers.service.ts:219`
- ~~**Overly broad `BLOCKED_BUTTON_KEYWORDS`**~~ — FIXED: keyword check changed from `includes()` to `=== || startsWith()` — blocks exact matches and prefixes only, allowing navigation text like "Hướng dẫn mua hàng". `telegram-bot.adapter.ts:120`
