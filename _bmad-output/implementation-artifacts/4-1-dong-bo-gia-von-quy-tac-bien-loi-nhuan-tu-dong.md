---
baseline_commit: 11d3b32779eda13d5d71152635b88445cdf7a776
---

# Story 4.1: Đồng bộ Giá Vốn & Quy tắc Biên lợi nhuận Tự động (Markup Rules Engine)

**Status:** done
**Epic:** 4 — Đa nguồn Cung ứng & Mua ngoài Tự động
**Created:** 2026-09-11
**Last Updated:** 2026-09-12 (code review passed — 1 decision resolved, 11 patches applied, 6 deferred)

---

## Story Statement

As a Store Operator,
I want external product catalog pricing to calculate automatically from supplier wholesale costs plus configurable markup rules,
So that my profit margins are consistently maintained when upstream prices fluctuate.

---

## Acceptance Criteria

- **Given** an external supplier product with wholesale cost $C$ and an active markup rule (percentage $+X\%$ and/or fixed $+Y$ VND),
- **When** the supplier price sync job runs,
- **Then** the retail price is recalculated as $Price = (C \times (1 + X/100)) + Y$, rounded to the nearest thousand VND.
- **And** if upstream cost rises above the maximum allowed threshold, the product is automatically deactivated with an alert logged for the Admin.

**AC bổ sung làm rõ (từ FR-13 PRD + phân tích codebase):**

3. Sync chỉ áp dụng cho product có `sourcingMode IN ('EXTERNAL','HYBRID')`, có `supplierSourceId` trỏ tới supplier `isActive = true`, và `autoPricing = true`. Product `IN_HOUSE` hoặc supplier inactive → bỏ qua (đếm `skipped`).
4. Giá trị cost không đổi và giá tính ra không đổi → không ghi DB (đếm `unchanged`), tránh dirty-write thừa.
5. Giá tính ra sau rounding < 1.000đ → floor về 1.000đ (không bao giờ niêm yết giá 0đ).
6. Khi `upstreamCost > maxUpstreamCost` (per-product, nullable — NULL = không giới hạn): set `products.isActive = false` + ghi 1 row `admin_alerts` + `logger.warn` + gửi Telegram admin alert (nếu `TELEGRAM_ADMIN_CHAT_ID` được cấu hình). **Chỉ alert khi transition active→inactive** — product đã inactive sẵn thì không spam alert mỗi lần sync.
7. Sync KHÔNG tự re-activate product đã bị deactivate (admin quyết định bật lại — tránh flapping khi giá dao động quanh ngưỡng).
8. Fetch cost lỗi cho 1 product → đếm `failed`, log warn, tiếp tục product khác — không làm chết cả job.
9. Có manual trigger endpoint `POST /api/products/sync-prices` (admin-only) trả về `PriceSyncSummaryDto`, và scheduled job BullMQ chạy định kỳ.

---

## Tasks / Subtasks

### Task 0: Extract shared money utils (retro action item Epic 1 #4 — đến lúc dùng lần thứ 3)

- [x] **0.1** Tạo `packages/shared-types/src/utils/decimal.ts` (NEW):
  - Move nguyên văn `parseSignedDecimal(value: string): bigint` và `formatSignedDecimal(units: bigint): string` từ `ledger.service.ts` (canonical copy — [Source: `apps/api/src/modules/ledger/ledger.service.ts:20-34`]).
  - `parseSignedDecimal` trả về **units scale-2** (1/100 VND): `'123456.78'` → `12345678n`. Cũng dùng được cho `markup_percentage` (`'20.00'` → `2000n` = basis points).
  - Export qua `packages/shared-types/src/utils/index.ts` → re-export từ `packages/shared-types/src/index.ts` (thêm `export * from './utils';`).
- [x] **0.2** Update `apps/api/src/modules/ledger/ledger.service.ts` — xóa 2 hàm local, import từ `@repo/shared-types`. **Giữ nguyên behavior 100%.**
- [x] **0.3** Update `apps/api/src/modules/orders/orders.service.ts` — xóa 2 hàm local ở `orders.service.ts:36-50`, import từ `@repo/shared-types`.
- [x] **0.4** Chạy lại `ledger.service.spec.ts` + `orders.service.spec.ts` — phải xanh nguyên (mechanical refactor, không đổi logic).

### Task 1: Database schema — `packages/database` (AC: tất cả)

- [x] **1.1** UPDATE `supplierSources` trong `packages/database/src/schema.ts`:
  - Thêm `markupFixedVnd: numeric('markup_fixed_vnd', { precision: 15, scale: 2 }).notNull().default('0.00')` — thành phần $Y$ của markup rule.
  - Thêm check `check('supplier_markup_fixed_non_negative', sql`${table.markupFixedVnd} >= 0`)` (mirror pattern `supplier_markup_non_negative` ở `schema.ts:98`).
- [x] **1.2** UPDATE `products` trong `schema.ts`:
  - `supplierProductUrl: varchar('supplier_product_url', { length: 512 })` — URL/SKU tham chiếu sản phẩm trên shop ngoài (input cho fetcher ở Story 4.3; v1 fetcher đọc priceMap nên cột này chủ yếu lưu metadata tham chiếu).
  - `upstreamCost: numeric('upstream_cost', { precision: 15, scale: 2 })` — giá vốn sync gần nhất; NULL = chưa từng sync.
  - `maxUpstreamCost: numeric('max_upstream_cost', { precision: 15, scale: 2 })` — ngưỡng giá vốn tối đa per-product; NULL = không giới hạn.
  - `costSyncedAt: timestamp('cost_synced_at', { withTimezone: true })` — lần sync cost cuối.
  - `autoPricing: boolean('auto_pricing').notNull().default(true)` — khi `false`, sync bỏ qua (bảo vệ giá admin set tay ở Story 5.1 khỏi bị job ghi đè).
  - Checks: `max_upstream_cost IS NULL OR max_upstream_cost > 0`, `upstream_cost IS NULL OR upstream_cost >= 0`.
- [x] **1.3** NEW table `adminAlerts` trong `schema.ts`:
  ```ts
  export const adminAlerts = pgTable('admin_alerts', {
    id: uuid('id').primaryKey().defaultRandom(),
    type: varchar('type', { length: 50 }).notNull(),          // AdminAlertType enum
    severity: varchar('severity', { length: 20 }).notNull().default('WARN'),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    supplierSourceId: uuid('supplier_source_id').references(() => supplierSources.id, { onDelete: 'set null' }),
    message: text('message').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  }, (table) => [
    index('admin_alerts_type_idx').on(table.type),
    index('admin_alerts_created_at_idx').on(table.createdAt),
    check('admin_alerts_type_valid', sql`${table.type} IN ('PRICE_THRESHOLD_EXCEEDED', 'PRICE_SYNC_FAILED')`),
  ]);
  ```
  - Đặt SAU `products` trong file (FK reference). Đây là surface dữ liệu cho Admin Console ở Epic 5.
- [x] **1.4** `pnpm --filter=@repo/database db:generate` → sinh migration `0008_*.sql`. **KHÔNG sửa file migration bằng tay** (lesson Epic 1). Review SQL generate ra trước khi apply.
- [x] **1.5** UPDATE `packages/database/src/seed.ts` — trên 'Partner Shop A' seed sẵn (`seed.ts:68-77`): thêm `markupFixedVnd: '10000.00'`, `configCredentials: { priceMap: { 'office-365': '80000.00', 'spotify-1m': '40000.00' } }`; trên 2 product EXTERNAL ('office-365', 'spotify-1m'): thêm `maxUpstreamCost`, `autoPricing: true`, `supplierProductUrl` mẫu. Seed phải idempotent theo name/slug như hiện tại.
- [x] **1.6** Rebuild package: `pnpm --filter=@repo/database build` (dist phải fresh trước khi api test — lesson Story 3.4: turbo `test` dependsOn `^build` đã cover, nhưng chạy tay `tsx --test` thì phải build trước).

### Task 2: Shared types — `packages/shared-types` (AC: #9)

- [x] **2.1** `enums/index.ts`: thêm
  ```ts
  export enum AdminAlertType {
    PRICE_THRESHOLD_EXCEEDED = 'PRICE_THRESHOLD_EXCEEDED',
    PRICE_SYNC_FAILED = 'PRICE_SYNC_FAILED',
  }
  export enum PriceSyncAction {
    UPDATED = 'UPDATED',
    UNCHANGED = 'UNCHANGED',
    DEACTIVATED = 'DEACTIVATED',
    FAILED = 'FAILED',
    SKIPPED = 'SKIPPED',
  }
  ```
- [x] **2.2** `dtos/index.ts`: thêm
  ```ts
  export interface PriceSyncItemDto {
    productId: string;
    slug: string;
    action: PriceSyncAction;
    upstreamCost?: string;
    oldPrice?: string;
    newPrice?: string;
    error?: string;
  }
  export interface PriceSyncSummaryDto {
    scanned: number;
    updated: number;
    unchanged: number;
    deactivated: number;
    failed: number;
    skipped: number;
    items: PriceSyncItemDto[];
    startedAt: string;
    finishedAt: string;
  }
  export interface SyncPricesResponseDto { ok: boolean; summary: PriceSyncSummaryDto; }
  ```
- [x] **2.3** `pnpm --filter=@repo/shared-types build`.

### Task 3: Pricing engine thuần — `products/pricing.engine.ts` (AC: #1, #5)

- [x] **3.1** Tạo `apps/api/src/modules/products/pricing.engine.ts` (NEW — pure functions, KHÔNG DI, KHÔNG Nest decorator):
  ```ts
  // Toàn bộ math bằng BigInt units scale-2. TUYỆT ĐỐI không float/number/parseFloat/toFixed.
  computeRetailPriceUnits(costUnits: bigint, markupPctBp: bigint, fixedUnits: bigint): bigint
  //   = (costUnits * (10_000n + markupPctBp) + 5_000n) / 10_000n + fixedUnits
  //   (5_000n = round-half-up ở sub-unit; markupPctBp = parseSignedDecimal('20.00') = 2000n)
  roundToThousandVnd(units: bigint): bigint
  //   = (units + 50_000n) / 100_000n * 100_000n   (1000đ = 100_000 units)
  //   floor: nếu kết quả <= 0n → trả 100_000n (giá sàn 1.000đ)
  computeRetailPrice(upstreamCost: string, markupPct: string, markupFixedVnd: string): string
  //   compose 2 hàm trên qua parseSignedDecimal/formatSignedDecimal → trả decimal string 'X.00'
  exceedsMaxCost(upstreamCost: string, maxUpstreamCost: string | null): boolean
  //   max null → false; else parseSignedDecimal(cost) > parseSignedDecimal(max)
  ```
- [x] **3.2** Tạo `pricing.engine.spec.ts` (NEW) — ít nhất các case:
  - `computeRetailPrice('100000.00', '20.00', '10000.00')` → `'130000.00'` (100k×1.2+10k, đã tròn nghìn).
  - Rounding: cost `'83333.33'`, pct `'20.00'`, fixed `'0.00'` → `(83333.33×1.2)=99999.996` → round `'100000.00'`.
  - Fixed-only: `('50000.00','0.00','15000.00')` → `'65000.00'`.
  - Pct-only lẻ: `('45000.00','15.50','0.00')` → `51975` → `'52000.00'`.
  - Floor: `('100.00','0.00','0.00')` → `'1000.00'`.
  - `exceedsMaxCost('200000.00','150000.00')` → `true`; `('100000.00','150000.00')` → `false`; `('999999.00', null)` → `false`.
  - Reject input sai format: `assert.throws(() => computeRetailPrice('abc','0','0'))`.

### Task 4: Price fetcher port (v1 = config-driven) (AC: #1)

- [x] **4.1** Tạo `apps/api/src/modules/products/supplier-price-fetcher.service.ts` (NEW):
  ```ts
  @Injectable()
  export class SupplierPriceFetcherService {
    /** v1: đọc giá vốn từ supplier.configCredentials.priceMap[product.slug].
     *  Story 4.3 sẽ bổ sung fetcher thật (WEB_SCRAPER/API) theo supplier.type —
     *  khi đó switch theo type ở đây, giữ nguyên signature. */
    async fetchUpstreamCost(
      product: typeof products.$inferSelect,
      supplier: typeof supplierSources.$inferSelect,
    ): Promise<string> // decimal string 'X.XX', throw Error('PRICE_FETCH_FAILED: ...') nếu không có
  }
  ```
  - Đọc `supplier.configCredentials?.priceMap?.[product.slug]` (config_credentials là `jsonb` — [Source: `schema.ts:91`]). Parse/validate bằng `parseSignedDecimal` — format sai hoặc thiếu → `throw new Error('PRICE_FETCH_FAILED: no configured cost for slug ...')`.
  - **KHÔNG bịa HTTP contract** cho type `API`/`WEB_SCRAPER` — v1 chỉ config-driven cho mọi type; đây là quyết định có chủ đích (real fetcher = Story 4.3, scope của nó là scraper mua hàng; price fetch thật đi cùng hạ tầng đó).
- [x] **4.2** Spec `supplier-price-fetcher.service.spec.ts` (NEW): priceMap hit, missing slug → throw, malformed string → throw, `configCredentials` null → throw.

### Task 5: Price sync orchestration — `products/price-sync.service.ts` (AC: #1–8)

- [x] **5.1** Tạo `apps/api/src/modules/products/price-sync.service.ts` (NEW):
  - Inject: `RedisService` (global module — không cần import RedisModule), `SupplierPriceFetcherService`, `TelegramBotService`.
  - `async syncAll(): Promise<PriceSyncSummaryDto>`:
    1. Best-effort global lock: `redisService.withLock('lock:price-sync', 300_000, routine)`. Catch `RedisUnavailableError`/Redlock errors → `logger.warn` rồi **chạy tiếp không lock** (mọi write đều idempotent; Postgres là source of truth — lesson Epic 1).
    2. Query targets — **join rộng rồi classify trong code** (để counter `skipped` đếm đúng — AC#3):
       ```ts
       db.select({ product: products, supplier: supplierSources })
         .from(products)
         .innerJoin(supplierSources, eq(products.supplierSourceId, supplierSources.id));
       ```
       `innerJoin` tự loại product có `supplierSourceId = NULL`. Với mỗi row, classify trước khi sync:
       - `sourcingMode === 'IN_HOUSE'` → `SKIPPED` (lý do: in-house không có giá vốn ngoài)
       - `product.autoPricing === false` → `SKIPPED` (admin set giá tay)
       - `supplier.isActive === false` → `SKIPPED`
       - còn lại → `syncOne(item)`; xử lý cả product `isActive=false` để cost tracking không bị đóng băng — nhưng KHÔNG re-activate.
       `innerJoin` là method của query builder — KHÔNG cần thêm export nào ở `@repo/database` (đã có `eq`, `inArray`, `and` sẵn nếu cần thêm điều kiện).
    3. Per product → `syncOne(item)` (bên dưới), gom `PriceSyncItemDto`, đếm counters, trả summary. Lỗi từng item không propagate.
  - `private async syncOne(product, supplier)`:
    1. `upstreamCost = await fetcher.fetchUpstreamCost(product, supplier)` — throw → item `FAILED`, log warn, return.
    2. Threshold: `exceedsMaxCost(upstreamCost, product.maxUpstreamCost)`:
       - Nếu `true` VÀ `product.isActive === true` → trong `db.transaction`: `SELECT ... FOR UPDATE` product row, set `isActive=false`, `upstreamCost`, `costSyncedAt=now()` (giữ nguyên `price` — không niêm yết giá vượt ngưỡng); insert `admin_alerts` (`PRICE_THRESHOLD_EXCEEDED`, payload `{productId, slug, upstreamCost, maxUpstreamCost}`); item `DEACTIVATED`. Sau commit: `void telegramBotService.sendAdminAlert(...)` fire-and-forget.
       - Nếu `true` VÀ `product.isActive === false` → chỉ cập nhật `upstreamCost`/`costSyncedAt` trong tx, item `UNCHANGED` (đã deactivate sẵn — không alert lại, AC#6).
    3. Ngược lại: `newPrice = computeRetailPrice(upstreamCost, supplier.markupPercentage, supplier.markupFixedVnd)`.
       - Nếu `newPrice === product.price` && `upstreamCost === product.upstreamCost` → item `UNCHANGED`, không write.
       - Khác → tx: `FOR UPDATE` product → update `price`, `upstreamCost`, `costSyncedAt` → item `UPDATED`.
    4. `logger.log` structured summary cuối run: `{scanned, updated, unchanged, deactivated, failed, skipped}`.
- [x] **5.2** Spec `price-sync.service.spec.ts` (NEW) — mock db chain theo pattern `products.service.spec.ts` (`Symbol.for('drizzle:Name')` để phân biệt bảng, `makeThenable` chain có `.for()` nếu query dùng `FOR UPDATE` — xem cách `ledger.service.spec.ts` mock `for: 'update'`). Cases:
  - Happy path: EXTERNAL product + supplier active + priceMap hit → `UPDATED`, `price` = giá markup đã round.
  - Cost đổi nhưng giá round ra y hệt và `upstreamCost` giống cũ → `UNCHANGED`, không update.
  - `upstreamCost > maxUpstreamCost` + `isActive=true` → `DEACTIVATED`, insert `admin_alerts`, gọi `sendAdminAlert`.
  - Breach + `isActive=false` sẵn → `UNCHANGED`, KHÔNG insert alert thứ 2.
  - Fetcher throw → `FAILED`, các product khác vẫn xử lý.
  - `IN_HOUSE` product có `supplierSourceId` → `SKIPPED` (join vẫn trả về, classify trong code loại ra); `autoPricing=false` → `SKIPPED`; supplier `isActive=false` → `SKIPPED`.
  - `sendAdminAlert` throw → item vẫn `DEACTIVATED` (notification failure không làm fail sync).
- [x] **5.3** Update `products.module.ts`: `providers: [ProductsService, PriceSyncService, SupplierPriceFetcherService]`, `exports` thêm 2 service mới, `imports: [TelegramBotModule]` (RedisService global rồi — không cần import).

### Task 6: AdminRoleGuard + manual trigger endpoint (AC: #9)

- [x] **6.1** Tạo `apps/api/src/common/guards/admin-role.guard.ts` (NEW):
  - `CanActivate` đọc `request.user` (TelegramUserDto do `TelegramAuthGuard` gắn — **phải dùng SAU TelegramAuthGuard**: `@UseGuards(TelegramAuthGuard, AdminRoleGuard)`).
  - Query `db.select().from(users).where(eq(users.telegramId, request.user.id)).limit(1)` — `users.telegramId` là `bigint mode:'number'` so sánh trực tiếp `number` [Source: `schema.ts:6`].
  - `user.role === 'ADMIN'` → true; ngược lại (kể cả user chưa có row — KHÔNG auto-create trong guard) → `ForbiddenException({ statusCode:403, errorCode:'AUTH_FORBIDDEN_NOT_ADMIN', message:'Admin role required' })`.
  - Guard dùng `db` import trực tiếp, không inject service → **không cần đăng ký vào providers**; `@UseGuards(AdminRoleGuard)` tự resolve qua Nest DI.
  - Guard này tái dùng cho Epic 5 admin endpoints.
- [x] **6.2** UPDATE `products.controller.ts` — thêm:
  ```ts
  @Post('sync-prices')
  @UseGuards(TelegramAuthGuard, AdminRoleGuard)
  async syncPrices(): Promise<SyncPricesResponseDto> {
    return { ok: true, summary: await this.priceSyncService.syncAll() };
  }
  ```
  - Inject `PriceSyncService` vào controller constructor. Giữ `GET /products` public nguyên vẹn (guard ở method-level, không class-level).
- [x] **6.3** Specs: `admin-role.guard.spec.ts` (NEW — mock request + mock db; 403 khi role CUSTOMER, 403 khi user không tồn tại, pass khi ADMIN) + update `products.controller.spec.ts` (endpoint delegate đúng, verify cả 2 guards trong metadata — pattern `Reflect.getMetadata('__guards__', ...)` như `orders.controller.spec.ts:22-25`).

### Task 7: Scheduled sync job — BullMQ (AC: #9, "job runs")

- [x] **7.1** Tạo `apps/api/src/workers/price-sync.scheduler.ts` (NEW — provider trong ProductsModule):
  ```ts
  @Injectable()
  export class PriceSyncScheduler implements OnModuleInit, OnModuleDestroy {
    // ⚠️ BẮT BUỘC: BullMQ Worker cần ioredis connection RIÊNG với maxRetriesPerRequest: null.
    // KHÔNG reuse RedisService.getClient() — client đó có maxRetriesPerRequest:1,
    // BullMQ sẽ throw/override với blocking commands.
    // ⚠️ KHÔNG khởi tạo connection ở field initializer — Nest instantiate provider
    // trước onModuleInit → sẽ mở kết nối kể cả khi PRICE_SYNC_DISABLED=true.
    private connection?: Redis;
    private queue?: Queue;
    private worker?: Worker;

    async onModuleInit() {
      if (process.env.PRICE_SYNC_DISABLED === 'true') return;   // tests/dev
      this.connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6381', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,                                // BullMQ docs khuyến nghị cho blocking conn
      });
      this.queue = new Queue('price-sync', { connection: this.connection });
      // ✅ Job Scheduler API — BullMQ 5.81.4 đã cài: upsertJobScheduler(id, repeatOpts, jobTemplate)
      // (legacy `repeat` deprecated từ 5.16, removed ở v6)
      await this.queue.upsertJobScheduler('price-sync-all',
        { every: Number(process.env.PRICE_SYNC_INTERVAL_MS ?? 900_000) },   // default 15 phút
        { name: 'sync-all', data: {} });
      this.worker = new Worker('price-sync', async () => { await this.priceSync.syncAll(); },
        { connection: this.connection });
    }
    async onModuleDestroy() {
      await this.worker?.close(); await this.queue?.close(); this.connection?.disconnect();
    }
  }
  ```
  - Worker processor bọc try/catch → log error, không throw (tránh BullMQ retry storm cho job định kỳ).
  - Đăng ký `PriceSyncScheduler` trong `products.module.ts` providers.
- [x] **7.2** KHÔNG viết spec cho scheduler (side-effect Redis connection) — coverage nằm ở `price-sync.service.spec.ts`. Verify thủ công bằng manual trigger endpoint + log.

### Task 8: Admin alert channel — Telegram (AC: #2, #6)

- [x] **8.1** UPDATE `telegram-bot.service.ts` — thêm `sendAdminAlert(text: string): Promise<void>`:
  - `chat_id = process.env.TELEGRAM_ADMIN_CHAT_ID`; env thiếu → `logger.warn` + return sớm (như pattern `sendOrderConfirmation` — `telegram-bot.service.ts:17-21`).
  - Reuse cùng fetch `api.telegram.org/bot{token}/sendMessage`, `parse_mode: 'HTML'`, fire-and-forget, không throw.
  - Message mẫu: `⚠️ <b>Giá vốn vượt ngưỡng</b>\n📦 {title} ({slug})\nGiá vốn: {upstreamCost} > Ngưỡng: {maxUpstreamCost}\nSản phẩm đã được tự động ẩn.`
- [x] **8.2** Update `telegram-bot.service.spec.ts` — case env missing → không gọi fetch; case gọi đúng `chat_id` admin.

### Task 9: Chạy verify tổng

- [x] **9.1** `cd /Users/luisphan/Documents/9router-upstream && pnpm turbo run lint build test` — toàn bộ xanh.
- [x] **9.2** Manual smoke (nếu infra chạy): `docker compose up -d postgres redis` → `pnpm db:migrate` + `pnpm db:seed` → trigger `POST /api/products/sync-prices` → verify `products.price` cập nhật đúng công thức và `admin_alerts` có row khi breach.

### Review Findings

- [x] [Review][Decision→Dismissed] `auto_pricing` default `true` trên product EXTERNAL có sẵn — **Resolved: giữ `default true`, không đổi code.** Lý do: v1 fetcher chỉ trả cost khi `configCredentials.priceMap[slug]` tồn tại — priceMap entry bản thân nó đã là opt-in; product EXTERNAL không có entry → `FAILED` item, giá không bị đụng. Đường overwrite duy nhất đi qua config do admin tự khai báo. Cần review lại khi Story 4.3 có live fetcher theo `supplierProductUrl` (lúc đó đã có Story 5.1 admin UI để tắt flag).
- [x] [Review][Patch→Fixed] Lock contention bị coi như fail-open — đã sửa: `routineRan` flag chống re-run sau khi routine đã chạy (ExecutionError post-routine → propagate); `ResourceLockedError`/`LockError` → skip run trả empty summary; chỉ `RedisUnavailableError`/`ExecutionError` khi routine chưa chạy mới fail-open. +3 spec cases (contention skip, Redis-down fail-open, post-routine no-rerun). [price-sync.service.ts:49-91]
- [x] [Review][Patch→Fixed] Double-rounding tại boundary 1.000đ — đã sửa: `computeRetailPriceUnits` gom `(costUnits*(10_000+bp) + fixedUnits*10_000)/10_000n` — truncation duy nhất, không round trung gian. Case `999.99×1.5+0.01=1499.995` → `1000.00` đúng. +1 regression spec (boundary + exact-half-up edge). [pricing.engine.ts:17-27]
- [x] [Review][Patch→Fixed] `syncOne` exception giết cả run — đã wrap call site trong try/catch → push `FAILED` item + `logger.error`, loop tiếp tục. +1 spec case (tx deadlock product 1 → product 2 vẫn UPDATED). [price-sync.service.ts:145-161]
- [x] [Review][Patch→Fixed] Stale snapshot trong tx — đã sửa: `SELECT ... FOR UPDATE` giờ đọc full row `fresh`, mọi quyết định (`autoPricing`, `isActive`, `maxUpstreamCost`, `price` compare, breach) dùng dữ liệu locked; tx trả về `TxOutcome` để post-tx xử lý. +2 spec cases (autoPricing flip → skip; isActive flip → no duplicate alert). [price-sync.service.ts:221-303]
- [x] [Review][Patch→Fixed] Thiếu `logger.warn` khi deactivate — đã thêm warn sau tx commit, trước Telegram (đủ 3 kênh theo AC#6). [price-sync.service.ts:305-311]
- [x] [Review][Patch→Fixed] `updatedAt` không set — đã thêm `updatedAt: sql`now()`` vào cả 3 update paths (deactivate, cost-refresh, price-update). [price-sync.service.ts:247,273,294]
- [x] [Review][Patch→Fixed] Env validation — `PRICE_SYNC_INTERVAL_MS` validate `Number.isFinite && > 0` TRƯỚC khi mở Redis connection (bad config không mở connection); `REDIS_URL` đổi `??`→`||` để empty-string fallback. [price-sync.scheduler.ts:21-32]
- [x] [Review][Patch→Fixed] `TELEGRAM_ADMIN_CHAT_ID` giờ `.trim()` ngay khi đọc env — check rỗng và `chat_id` gửi đi đều dùng giá trị đã trim. [telegram-bot.service.ts:74-78]
- [x] [Review][Patch→Fixed] Thêm subpath export `./utils` vào `packages/shared-types/package.json` — đồng nhất với `./enums`/`./dtos`.
- [x] [Review][Patch→Fixed] `innerJoin`→`leftJoin` + `WHERE (sourcingMode IN ('EXTERNAL','HYBRID') OR supplierSourceId IS NOT NULL)` — product EXTERNAL không link supplier giờ vẫn vào `scanned`/`SKIPPED` thay vì biến mất âm thầm; IN_HOUSE không link vẫn loại khỏi scan (không phải sync target). Thêm `or`/`isNotNull` vào `@repo/database` exports. +1 spec row `supplier: null`. [price-sync.service.ts:99-114]
- [x] [Review][Patch→Fixed] `priceMap` coerce finite `number` → `String(rawCost)` trước validation — `"80000"` và `80000` đều parse được, `NaN`/`Infinity`/non-string vẫn reject. +1 spec case. [supplier-price-fetcher.service.ts:34-45]
- [x] [Review][Defer] Orders idempotency key không scoped theo user — `getOrderByIdempotencyKey` chỉ lọc theo key, global unique → user khác replay key đã biết sẽ nhận được order + `deliveredCredential` của người khác. [orders.service.ts:85-92,108-115] — deferred, pre-existing (Epic 3)
- [x] [Review][Defer] Checkout đọc `products` không `FOR UPDATE` — race với price-sync (giá/isActive đổi giữa read và debit trong cùng READ COMMITTED tx). [orders.service.ts:126-134] — deferred, pre-existing (Epic 3)
- [x] [Review][Defer] `ledger.recordTransaction` idempotency check chỉ theo `idempotencyKey` không kèm `walletId`; retry 23505 bằng `select` trong tx đã abort sẽ fail tiếp trên Postgres thật. [ledger.service.ts:336-342,388-397] — deferred, pre-existing (Epic 1)
- [x] [Review][Defer] `captureHold` ghi ledger `amount` âm nhưng `balanceAfter == balanceBefore` — vi phạm invariant ledger khi hold/capture được dùng (hiện chưa có caller). [ledger.service.ts:295-302] — deferred, pre-existing (deferred hold/capture work)
- [x] [Review][Defer] Spec test 23505 trong `ledger.service.spec.ts` chỉ mock, không phản ánh transaction-abort thật của Postgres. — deferred, pre-existing (test-quality)
- [x] [Review][Defer] `PRICE_SYNC_FAILED` đã định nghĩa trong enum + DB CHECK nhưng không bao giờ insert — cần design chống spam (vd alert khi fail N lần liên tiếp) trước khi bật. [price-sync.service.ts:162-172] — deferred, reserved for future use

---

## Dev Notes

### Codebase Context (đã validate trực tiếp trên code)

1. **Chưa có gì về pricing/supplier sync** — `SuppliersModule` là stub rỗng (`suppliers.module.ts` chỉ có `@Module({})`), `apps/api/src/workers/` chỉ có `.gitkeep`. Story này dựng nền: fetcher port + sync orchestration + scheduler. **KHÔNG tái sử dụng được code scraper nào — chưa tồn tại.**
2. **Placement = `modules/products/`** theo Capability Map: `FR-13 → apps/api/src/modules/products` [Source: `ARCHITECTURE-SPINE.md` §7]. `SuppliersModule` dành cho Story 4.3 (scraper/sourcing theo AD-7).
3. **`supplier_sources.markup_percentage`** đã tồn tại (`numeric(8,2)`, check `>= 0`) — chỉ thiếu phần fixed và threshold. Seed 'Partner Shop A' dùng `'20.00'` [Source: `schema.ts:92`, `seed.ts:74`].
4. **`products`** đã có `price`, `sourcingMode`, `supplierSourceId` — thiếu `upstreamCost`/`maxUpstreamCost`/`autoPricing`/`supplierProductUrl`/`costSyncedAt` → Task 1.2 thêm.
5. **`supplier_orders` table chưa có trong schema** — đó là Story 4.3, KHÔNG thêm ở story này.
6. **Money = string + BigInt scale-2** — `parseSignedDecimal`/`formatSignedDecimal` đang duplicated ở `ledger.service.ts:20-34` và `orders.service.ts:36-50`. Task 0 extract (retro Epic 1 action item #4). Cấm `parseFloat`/`toFixed`/`number` cho tiền.
7. **RedisService global** (`@Global` module) — inject trực tiếp không cần import; `withLock(resource, ttlMs, routine)` signature [Source: `redis.service.ts:55`]. Client của nó có `maxRetriesPerRequest: 1` → **tuyệt đối không truyền vào BullMQ Worker**.
8. **TelegramBotService** hiện chỉ có `sendOrderConfirmation` — thêm `sendAdminAlert` (Task 8). `TelegramBotModule` KHÔNG global → phải import vào ProductsModule.
9. **Không có AdminGuard** — `users.role` + `UserRole.ADMIN` tồn tại nhưng chưa có guard; Task 6.1 tạo `AdminRoleGuard`.
10. **`ProductsController` hiện public** — `GET /products` cố ý không guard (catalog browse trước auth). Guard admin chỉ gắn method-level trên endpoint mới.
11. **`@repo/database` exports hiện tại**: `{ schema, eq, sql, inArray, and, desc }` [Source: `packages/database/src/index.ts:26`]. `leftJoin`/`innerJoin`/`.for('update')`/`.groupBy()` là **method của query builder** — không cần export. Chỉ top-level helpers (`isNotNull`, `ne`, `gt`, `lt`...) mới cần thêm vào re-export nếu dùng.

### Architecture Rules (bắt buộc)

- **Thin controller / fat service**: controller chỉ guard + delegate; logic nằm trong service.
- **Schema-first**: sửa `schema.ts` → `drizzle-kit generate` → apply. Không sửa SQL migration tay.
- **Service tự bọc transaction** khi cần (không assume caller truyền `tx`).
- **State mutation qua transaction**: update `products`/`admin_alerts` trong `db.transaction` + `SELECT FOR UPDATE`.
- **Mọi biến động ví mới qua LedgerService** — story này KHÔNG đụng wallet.
- **Error shape**: `{ statusCode, errorCode, message, timestamp, path }` qua `AllExceptionsFilter` + Nest `HttpException`.
- **Naming**: code/DB tiếng Anh (`snake_case` Postgres, `camelCase` TS); comment/docs tiếng Việt.
- **Fire-and-forget notifications** — `void service.sendX().catch(()=>{})`, không `await`, không block.
- **ESM imports top-level only** (lesson Story 3.1).

### Công thức giá (contract — dev implement đúng, không tự sáng tạo)

```
Price = (C × (1 + X/100)) + Y   →  round nearest 1.000đ (half-up)  →  floor 1.000đ

C      = upstreamCost           (products.upstream_cost, NUMERIC(15,2))
X      = supplier.markupPercentage   ('20.00' → 20% → 2000 basis points)
Y      = supplier.markupFixedVnd     (NUMERIC(15,2), default '0.00')
units  = parseSignedDecimal(str)     (scale-2: '1.00' → 100n)

threshold check: C > products.max_upstream_cost (NULL = vô hạn) → deactivate + alert
```

### File Structure

```
packages/database/src/
  schema.ts                     # UPDATE — supplier_sources +1 col, products +5 cols, +admin_alerts
  seed.ts                       # UPDATE — priceMap/markupFixedVnd/maxUpstreamCost mẫu
packages/database/drizzle/
  0008_*.sql                    # NEW (generate, không viết tay)
packages/shared-types/src/
  utils/decimal.ts              # NEW — parseSignedDecimal/formatSignedDecimal (extract)
  utils/index.ts                # NEW
  enums/index.ts                # UPDATE — AdminAlertType, PriceSyncAction
  dtos/index.ts                 # UPDATE — PriceSync*Dto
apps/api/src/
  common/money/                 # KHÔNG tạo — dùng shared-types
  common/guards/admin-role.guard.ts            # NEW + spec
  common/telegram/telegram-bot.service.ts      # UPDATE — sendAdminAlert
  modules/products/
    pricing.engine.ts           # NEW — pure BigInt markup calc
    pricing.engine.spec.ts      # NEW
    supplier-price-fetcher.service.ts   # NEW — config priceMap fetcher (v1)
    supplier-price-fetcher.service.spec.ts # NEW
    price-sync.service.ts       # NEW — orchestration
    price-sync.service.spec.ts  # NEW
    products.controller.ts      # UPDATE — POST /products/sync-prices
    products.controller.spec.ts # UPDATE
    products.module.ts          # UPDATE — providers/imports
  workers/price-sync.scheduler.ts # NEW — BullMQ Job Scheduler + Worker
  modules/ledger/ledger.service.ts   # UPDATE — dùng shared decimal utils
  modules/orders/orders.service.ts   # UPDATE — dùng shared decimal utils
```

### Test Standards (VALIDATED)

- **Framework**: `node:test` + `assert` — KHÔNG vitest. `import { test } from 'node:test'`.
- **Vị trí**: spec co-located cùng folder source trong `apps/api/src/` và `packages/*/src/`.
- **Chạy**: `cd apps/api && npx tsx --test src/**/*.spec.ts` (build `@repo/database` + `@repo/shared-types` trước).
- **Mock drizzle**: thenable chain, phân biệt bảng bằng `table[Symbol.for('drizzle:Name')]`; `update().set().where()` KHÔNG có `.returning()` trừ khi code dùng — match exact chain (lesson Epic 1).
- **Mock service**: `new PriceSyncService(mockRedis, mockFetcher, mockBot)` — constructor injection, track calls bằng array.
- **fetch mock**: gán `globalThis.fetch` thủ công trong try/finally — KHÔNG `vi.stubGlobal`.
- **Guard metadata test**: `Reflect.getMetadata('__guards__', ProductsController.prototype.syncPrices)`.

### Known Risks & Edge Cases

1. **BullMQ connection trap**: Worker bắt buộc `maxRetriesPerRequest: null` — tạo ioredis riêng, không reuse `RedisService` client. `upsertJobScheduler` (không `repeat` — deprecated từ 5.16, removed ở v6).
2. **Float money bug**: cấm float; pct parse thành basis points (×100) trước khi nhân — `'20.00'` → `2000n`.
3. **Rounding**: half-up về nghìn đồng; kết quả ≤ 0 → floor 1.000đ.
4. **Alert spam**: chỉ insert `admin_alerts` + Telegram khi transition `isActive true→false`.
5. **Không auto re-activate** — quyết định có chủ đích, document trong code comment.
6. **Sync product inactive**: vẫn cập nhật `upstreamCost`/`costSyncedAt` (tracking tươi) nhưng không đổi `isActive`.
7. **Race với admin sửa giá (Story 5.1 tương lai)**: `auto_pricing=false` skip; per-product `FOR UPDATE` trong tx.
8. **Fetcher v1 là config-driven** — đừng bịa API contract; Story 4.3 sẽ switch theo `supplier.type`.
9. **Env mới**: `PRICE_SYNC_INTERVAL_MS` (default 900000), `PRICE_SYNC_DISABLED` (true khi test), `TELEGRAM_ADMIN_CHAT_ID` — thêm vào `apps/api/.env.example` (file đã tồn tại).
10. **Constructor changes**: `ProductsController` thêm `PriceSyncService` param → update `new ProductsController(service)` ở `products.controller.spec.ts:14`.
11. **Queue retry storm**: worker processor catch-all → log, không rethrow (job định kỳ tự chạy lại ở kỳ sau).
12. **HYBRID + còn kho nội bộ khi breach**: product HYBRID có `maxUpstreamCost` bị vượt vẫn bị `isActive=false` dù kho nội bộ còn credential AVAILABLE → ẩn khỏi catalog dù còn bán được từ kho. Đây là quyết định có chủ đích theo đúng chữ AC ("product is automatically deactivated"); nếu sau này muốn chỉ tắt nhánh external mà vẫn bán kho nội bộ → cần field riêng (vd `external_sourcing_enabled`) — defer cho Story 5.1.
13. **`orders.price` là snapshot** tại thời điểm checkout (`orders.service.ts:187` — `price: product.price`) → đổi giá catalog không ảnh hưởng đơn đã tạo; không cần xử lý gì thêm.

### Previous Story Intelligence (không có story trước trong Epic 4 — đây là story đầu; tổng hợp từ Epic 1–3)

- **Epic 1 retro**: schema-first discipline; mock drizzle match exact call chain; service tự mở tx khi không có `tx`; money=string/BigInt; mọi lỗi DB map `errorCode` (`23505` idempotency, `23514` check violation).
- **Story 3.4**: `leftJoin`/`desc` export đã thêm; `toOrderDto` optional-param backward-compat; fetch mock thủ công; rebuild `packages/database` trước khi chạy test api.
- **Story 3.1→3.2 deferred**: `products.price` đã có `CHECK (price >= 0)`; index `supplier_source_id` + `(is_active, category)` đã có; AES-256-GCM credential encrypt ở `@repo/database` — story này không đụng credential.
- **Story 2.4 deferred**: `redlock` pinned `5.0.0-beta.2` (ships own types); `withLock` propagates `signal` — nếu routine dài, check `signal.aborted` giữa các item lớn.

### Latest Tech Information (web research 2026-09-11)

- **BullMQ `^5.41.0` (đã cài)**: legacy `repeat` APIs deprecated từ 5.16.0 và **removed ở v6** → dùng `queue.upsertJobScheduler(id, { every: ms }, { name, data })`. First repetition chạy ngay khi scheduler mới được tạo.
- **BullMQ Worker connection**: ioredis phải có `maxRetriesPerRequest: null` (blocking ops); BullMQ tự duplicate connection khi cần — 1 connection object share được cho cả `Queue` + `Worker`.
- **redlock `5.0.0-beta.2`** pinned — `withLock` đã handle auto-extension (threshold 500ms) + abort propagation.

### References

- Epic/AC: `_bmad-output/planning-artifacts/epics.md` — Story 4.1, FR-13 (FR Coverage Map)
- Kiến trúc: `ARCHITECTURE-SPINE.md` §2 AD-4/AD-5/AD-7, §4 Consistency Conventions, §6 ERD, §7 Capability Map
- PRD: `prd.md` FR-13 (§4.4), NFR-6/7; `addendum.md` §2 (ledger/money), §3 (Redlock), §5 (state machine)
- Money pattern: `apps/api/src/modules/ledger/ledger.service.ts:20-34`, `orders.service.ts:36-50`
- Lock pattern: `apps/api/src/common/redis/redis.service.ts:55-71`, `payments.service.ts` (`lock:payment:{id}`)
- Schema hiện tại: `packages/database/src/schema.ts:84-169`, seed `seed.ts:61-100`
- Test pattern: `products.service.spec.ts` (mock drizzle by table name), `orders.controller.spec.ts:22-25` (guard metadata)

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5

### Debug Log References

- Task 0: Extracted `parseSignedDecimal` and `formatSignedDecimal` to `packages/shared-types/src/utils/decimal.ts`. Refactored `ledger.service.ts` and `orders.service.ts` to import them; verified all 27 ledger & orders tests pass.
- Task 1: Updated `packages/database/src/schema.ts` with `markupFixedVnd` on `supplier_sources`, 5 new columns on `products`, and new `admin_alerts` table. Generated migration `drizzle/0008_outgoing_glorian.sql` using `drizzle-kit generate`. Seed updated and applied to PostgreSQL container.
- Task 2: Added `AdminAlertType` and `PriceSyncAction` enums, added `PriceSyncItemDto`, `PriceSyncSummaryDto`, `SyncPricesResponseDto` to `packages/shared-types`.
- Task 3: Implemented pure BigInt math in `pricing.engine.ts` with nearest 1,000 VND rounding and 1,000 VND floor. 6 unit tests passing.
- Task 4: Implemented `SupplierPriceFetcherService` reading `priceMap` from supplier JSONB credentials. 4 unit tests passing.
- Task 5: Implemented `PriceSyncService` with distributed locking, classification (skipping IN_HOUSE, inactive suppliers, autoPricing=false), threshold checking, transaction updates, and admin alert logging. 7 unit tests passing.
- Task 6: Implemented `AdminRoleGuard` and `POST /api/products/sync-prices` endpoint. 6 unit tests passing across guard and controller specs.
- Task 7: Implemented `PriceSyncScheduler` using BullMQ `upsertJobScheduler` with independent connection.
- Task 8: Added `sendAdminAlert` to `TelegramBotService`. 5 unit tests passing.
- Task 9: Full turbo lint, build, and test suites green. Live smoke test against PostgreSQL verified price updates and dirty-write prevention.

### Completion Notes List

- All Acceptance Criteria (AC 1-9) fully satisfied.
- 225/225 unit tests passing in `apps/api`.
- Monorepo turbo build & test 100% green.

### File List

- `packages/shared-types/src/utils/decimal.ts` (NEW)
- `packages/shared-types/src/utils/index.ts` (NEW)
- `packages/shared-types/src/index.ts` (MODIFIED)
- `packages/shared-types/src/enums/index.ts` (MODIFIED)
- `packages/shared-types/src/dtos/index.ts` (MODIFIED)
- `packages/database/src/schema.ts` (MODIFIED)
- `packages/database/src/schema.spec.ts` (MODIFIED)
- `packages/database/src/seed.ts` (MODIFIED)
- `packages/database/drizzle/0008_outgoing_glorian.sql` (NEW)
- `packages/database/drizzle/meta/_journal.json` (MODIFIED)
- `packages/database/drizzle/meta/0008_snapshot.json` (NEW)
- `apps/api/src/modules/ledger/ledger.service.ts` (MODIFIED)
- `apps/api/src/modules/orders/orders.service.ts` (MODIFIED)
- `apps/api/src/common/guards/admin-role.guard.ts` (NEW)
- `apps/api/src/common/guards/admin-role.guard.spec.ts` (NEW)
- `apps/api/src/common/telegram/telegram-bot.service.ts` (MODIFIED)
- `apps/api/src/common/telegram/telegram-bot.service.spec.ts` (MODIFIED)
- `apps/api/src/modules/products/pricing.engine.ts` (NEW)
- `apps/api/src/modules/products/pricing.engine.spec.ts` (NEW)
- `apps/api/src/modules/products/supplier-price-fetcher.service.ts` (NEW)
- `apps/api/src/modules/products/supplier-price-fetcher.service.spec.ts` (NEW)
- `apps/api/src/modules/products/price-sync.service.ts` (NEW)
- `apps/api/src/modules/products/price-sync.service.spec.ts` (NEW)
- `apps/api/src/modules/products/products.controller.ts` (MODIFIED)
- `apps/api/src/modules/products/products.controller.spec.ts` (MODIFIED)
- `apps/api/src/modules/products/products.module.ts` (MODIFIED)
- `apps/api/src/workers/price-sync.scheduler.ts` (NEW)
- `apps/api/.env.example` (MODIFIED)
- `apps/api/.env` (MODIFIED)

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-09-11 | Completed implementation of Story 4.1: markup rules engine, price sync service, BullMQ scheduler, admin guard, alert channel | Claude Dev Agent |
| 2026-09-11 | Story created and validated | BMad Create-Story |
