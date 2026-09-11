import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  db,
  eq,
  sql,
  or,
  isNotNull,
  inArray,
  products,
  supplierSources,
  adminAlerts,
  type DbOrTx,
} from '@repo/database';
import {
  AdminAlertType,
  PriceSyncAction,
  ProductSourcingMode,
  type PriceSyncItemDto,
  type PriceSyncSummaryDto,
} from '@repo/shared-types';
import { RedisService, RedisUnavailableError } from '../../common/redis/redis.service';
import { SupplierPriceFetcherService } from './supplier-price-fetcher.service';
import { TelegramBotService, escapeHtml } from '../../common/telegram/telegram-bot.service';
import { computeRetailPrice, exceedsMaxCost } from './pricing.engine';

@Injectable()
export class PriceSyncService {
  private readonly logger = new Logger(PriceSyncService.name);
  private readonly dbClient: DbOrTx;

  constructor(
    private readonly redisService: RedisService,
    private readonly priceFetcher: SupplierPriceFetcherService,
    private readonly telegramBotService: TelegramBotService,
    @Optional() dbClient?: DbOrTx,
  ) {
    this.dbClient = dbClient ?? db;
  }

  /**
   * Orchestrates price synchronization across all eligible external products.
   * Lock semantics:
   * - Lock contention (another run holds it) -> skip this run, never run unlocked.
   * - Lock infrastructure down (Redis unavailable) -> fail open; all writes are
   *   idempotent and Postgres stays the source of truth.
   * - Any error thrown AFTER the routine already ran (e.g. lock lost mid-run) ->
   *   propagate, never re-run blindly (would double-process).
   */
  async syncAll(): Promise<PriceSyncSummaryDto> {
    let routineRan = false;
    try {
      return await this.redisService.withLock(
        'lock:price-sync',
        300_000,
        async () => {
          routineRan = true;
          return this.runSyncRoutine();
        },
      );
    } catch (err: any) {
      if (routineRan) throw err;
      if (err?.name === 'ResourceLockedError' || err?.name === 'LockError') {
        this.logger.warn(
          'Price sync skipped — lock:price-sync is held by another run',
        );
        return this.emptySummary();
      }
      if (err instanceof RedisUnavailableError || err?.name === 'ExecutionError') {
        this.logger.warn(
          `Price sync lock unavailable (${err?.message || String(err)}) — running without lock`,
        );
        return this.runSyncRoutine();
      }
      throw err;
    }
  }

  private emptySummary(): PriceSyncSummaryDto {
    const now = new Date().toISOString();
    return {
      scanned: 0,
      updated: 0,
      unchanged: 0,
      deactivated: 0,
      failed: 0,
      skipped: 0,
      items: [],
      startedAt: now,
      finishedAt: now,
    };
  }

  /**
   * Core sync routine.
   */
  private async runSyncRoutine(): Promise<PriceSyncSummaryDto> {
    const startedAt = new Date().toISOString();

    // Scan scope: all supplier-linked products (leftJoin keeps rows whose supplier
    // row is missing -> classified SKIPPED below) plus every EXTERNAL/HYBRID product.
    // Plain IN_HOUSE products with no supplier link are not sync targets at all.
    const rows = await this.dbClient
      .select({ product: products, supplier: supplierSources })
      .from(products)
      .leftJoin(supplierSources, eq(products.supplierSourceId, supplierSources.id))
      .where(
        or(
          inArray(products.sourcingMode, [
            ProductSourcingMode.EXTERNAL,
            ProductSourcingMode.HYBRID,
          ]),
          isNotNull(products.supplierSourceId),
        ),
      );

    const items: PriceSyncItemDto[] = [];
    let scanned = 0;
    let updated = 0;
    let unchanged = 0;
    let deactivated = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of rows) {
      scanned++;
      const { product, supplier } = row;

      // Classify before sync (AC #3)
      if (
        supplier === null ||
        product.sourcingMode === ProductSourcingMode.IN_HOUSE ||
        product.autoPricing === false ||
        supplier.isActive === false
      ) {
        skipped++;
        items.push({
          productId: product.id,
          slug: product.slug,
          action: PriceSyncAction.SKIPPED,
          oldPrice: product.price,
        });
        continue;
      }

      // Isolate per-item failures: one bad product must not abort the whole run.
      let result: PriceSyncItemDto;
      try {
        result = await this.syncOne(product, supplier);
      } catch (err: any) {
        this.logger.error(
          `Price sync failed unexpectedly for ${product.slug} (${product.id}): ${err?.message || String(err)}`,
          err?.stack,
        );
        result = {
          productId: product.id,
          slug: product.slug,
          action: PriceSyncAction.FAILED,
          oldPrice: product.price,
          error: err?.message || String(err),
        };
      }
      items.push(result);

      if (result.action === PriceSyncAction.UPDATED) updated++;
      else if (result.action === PriceSyncAction.UNCHANGED) unchanged++;
      else if (result.action === PriceSyncAction.DEACTIVATED) deactivated++;
      else if (result.action === PriceSyncAction.FAILED) failed++;
      else if (result.action === PriceSyncAction.SKIPPED) skipped++;
    }

    const finishedAt = new Date().toISOString();

    this.logger.log(
      `Price sync completed: ${JSON.stringify({ scanned, updated, unchanged, deactivated, failed, skipped })}`,
    );

    return {
      scanned,
      updated,
      unchanged,
      deactivated,
      failed,
      skipped,
      items,
      startedAt,
      finishedAt,
    };
  }

  /**
   * Sync a single product with its supplier wholesale cost and markup rules.
   * All write decisions are made inside the transaction on a freshly-locked row —
   * the scan snapshot may be stale (autoPricing/isActive/maxUpstreamCost flipped
   * between scan and write).
   */
  private async syncOne(
    product: typeof products.$inferSelect,
    supplier: typeof supplierSources.$inferSelect,
  ): Promise<PriceSyncItemDto> {
    let upstreamCost: string;
    try {
      upstreamCost = await this.priceFetcher.fetchUpstreamCost(product, supplier);
    } catch (err: any) {
      this.logger.warn(
        `Price fetch failed for ${product.slug} (${product.id}): ${err?.message || String(err)}`,
      );
      return {
        productId: product.id,
        slug: product.slug,
        action: PriceSyncAction.FAILED,
        oldPrice: product.price,
        error: err?.message || String(err),
      };
    }

    type TxOutcome = 'gone' | 'skipped' | 'deactivated' | 'updated' | 'unchanged';
    let oldPrice = product.price;
    let newPrice = product.price;
    let breachMax = product.maxUpstreamCost;

    const outcome: TxOutcome = await this.dbClient.transaction(
      async (tx): Promise<TxOutcome> => {
        const [fresh] = await tx
          .select()
          .from(products)
          .where(eq(products.id, product.id))
          .for('update');

        if (!fresh) return 'gone';

        oldPrice = fresh.price;
        newPrice = fresh.price;
        breachMax = fresh.maxUpstreamCost;

        // Flag may have been flipped between scan and write.
        if (fresh.autoPricing === false) return 'skipped';

        if (exceedsMaxCost(upstreamCost, fresh.maxUpstreamCost)) {
          if (fresh.isActive === true) {
            // Active product exceeding threshold -> deactivate and create admin alert
            await tx
              .update(products)
              .set({
                isActive: false,
                upstreamCost,
                costSyncedAt: sql`now()`,
                updatedAt: sql`now()`,
              })
              .where(eq(products.id, product.id));

            const alertMessage = `Upstream cost ${upstreamCost} exceeded max threshold ${fresh.maxUpstreamCost} for product ${product.title} (${product.slug})`;
            await tx.insert(adminAlerts).values({
              type: AdminAlertType.PRICE_THRESHOLD_EXCEEDED,
              severity: 'WARN',
              productId: product.id,
              supplierSourceId: supplier.id,
              message: alertMessage,
              payload: {
                productId: product.id,
                slug: product.slug,
                upstreamCost,
                maxUpstreamCost: fresh.maxUpstreamCost,
              },
            });
            return 'deactivated';
          }

          // Already inactive -> refresh cost bookkeeping, no duplicate alert
          if (upstreamCost !== fresh.upstreamCost) {
            await tx
              .update(products)
              .set({
                upstreamCost,
                costSyncedAt: sql`now()`,
                updatedAt: sql`now()`,
              })
              .where(eq(products.id, product.id));
          }
          return 'unchanged';
        }

        const computed = computeRetailPrice(
          upstreamCost,
          supplier.markupPercentage,
          supplier.markupFixedVnd,
        );
        if (computed === fresh.price && upstreamCost === fresh.upstreamCost) {
          return 'unchanged';
        }

        await tx
          .update(products)
          .set({
            price: computed,
            upstreamCost,
            costSyncedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(products.id, product.id));
        newPrice = computed;
        return 'updated';
      },
    );

    if (outcome === 'deactivated') {
      this.logger.warn(
        `Product ${product.slug} (${product.id}) deactivated — upstream cost ${upstreamCost} exceeds max threshold ${breachMax}`,
      );
      const tgText = `⚠️ <b>Giá vốn vượt ngưỡng</b>\n📦 ${escapeHtml(product.title)} (${escapeHtml(product.slug)})\nGiá vốn: ${upstreamCost} > Ngưỡng: ${breachMax}\nSản phẩm đã được tự động ẩn.`;
      void this.telegramBotService.sendAdminAlert(tgText).catch(() => {});
    }

    if (outcome === 'gone' || outcome === 'skipped') {
      return {
        productId: product.id,
        slug: product.slug,
        action: PriceSyncAction.SKIPPED,
        upstreamCost,
        oldPrice,
      };
    }
    if (outcome === 'deactivated') {
      return {
        productId: product.id,
        slug: product.slug,
        action: PriceSyncAction.DEACTIVATED,
        upstreamCost,
        oldPrice,
        newPrice,
      };
    }
    if (outcome === 'updated') {
      return {
        productId: product.id,
        slug: product.slug,
        action: PriceSyncAction.UPDATED,
        upstreamCost,
        oldPrice,
        newPrice,
      };
    }
    return {
      productId: product.id,
      slug: product.slug,
      action: PriceSyncAction.UNCHANGED,
      upstreamCost,
      oldPrice,
      newPrice,
    };
  }
}
