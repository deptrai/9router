import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  db,
  eq,
  and,
  supplierSources,
  products,
  adminAlerts,
  type DbOrTx,
} from '@repo/database';
import { AdminAlertType } from '@repo/shared-types';
import { TelegramBotAdapter } from './adapters/telegram-bot.adapter';
import { CatalogParserService, type ParsedCatalogProduct } from './catalog-parser.service';
import { RedisService } from '../../../common/redis/redis.service';
import { TelegramBotService } from '../../../common/telegram/telegram-bot.service';
import { generateUniqueSlug } from '../../products/utils/slug.util';
import { computeRetailPrice } from '../../products/pricing.engine';

export interface SyncSupplierCatalogResult {
  ok: boolean;
  skipped?: boolean;
  productsCount: number;
}

@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);
  protected db: any = db;

  constructor(
    @Inject(TelegramBotAdapter)
    private readonly telegramBotAdapter: TelegramBotAdapter,
    @Inject(CatalogParserService)
    private readonly catalogParserService: CatalogParserService,
    @Inject(RedisService)
    private readonly redisService: RedisService,
    @Inject(TelegramBotService)
    private readonly telegramBotService: TelegramBotService,
  ) {}

  /**
   * Orchestrate catalog synchronization for a single supplier:
   * 1. Query supplier from DB (guard active + type TELEGRAM_BOT).
   * 2. Call adapter to fetch catalog from relay.
   * 3. Call parser to extract products.
   * 4. Deduplicate products by supplierProductId.
   * 5. In a DB transaction, sequentially upsert products:
   *    - INSERT: sourcingMode='IN_HOUSE', isActive=false, autoPricing=true, unique slug, computed price.
   *    - UPDATE: preserve isActive & slug, update upstreamCost/stock, update price if autoPricing, update title/desc if draft.
   * 6. Track success (reset consecutiveSyncFailures=0) or failure (increment counter, throttled alert on 3rd failure, clear debounce).
   */
  async syncSupplierCatalog(supplierId: string): Promise<SyncSupplierCatalogResult> {
    const [supplier] = await this.db
      .select()
      .from(supplierSources)
      .where(eq(supplierSources.id, supplierId))
      .limit(1);

    if (!supplier || !supplier.isActive || supplier.type !== 'TELEGRAM_BOT') {
      this.logger.warn(
        `Supplier ${supplierId} not found, inactive, or not TELEGRAM_BOT. Skipping sync.`,
      );
      // Release the debounce lock so a subsequent manual sync is not blocked
      // after the supplier is re-activated.
      await this.clearDebounce(supplierId);
      return { ok: false, skipped: true, productsCount: 0 };
    }

    try {
      // 1. Fetch raw catalog from relay via adapter
      const rawCatalog = await this.telegramBotAdapter.fetchCatalog(supplier.configCredentials);

      // 2. Parse catalog
      const cfg = (supplier.configCredentials || {}) as Record<string, any>;
      const botUsername = String(cfg.botUsername || '').trim().replace(/^@+/, '');
      const vndPerCredit = Number(cfg.vndPerCredit);
      const parseMode = cfg.parseMode;

      const parsedProducts = this.catalogParserService.parse(rawCatalog, {
        botUsername,
        vndPerCredit,
        parseMode,
      });

      if (!parsedProducts || parsedProducts.length === 0) {
        throw new Error('PARSER_ZERO_PRODUCTS');
      }

      // 3. Deduplicate by supplierProductId (keep last entry)
      const dedupedMap = new Map<string, ParsedCatalogProduct>();
      for (const p of parsedProducts) {
        dedupedMap.set(p.supplierProductId, p);
      }
      const uniqueProducts = Array.from(dedupedMap.values());

      // 4. Upsert in transaction
      await this.db.transaction(async (tx: DbOrTx) => {
        for (const p of uniqueProducts) {
          const [existingProduct] = await tx
            .select()
            .from(products)
            .where(
              and(
                eq(products.supplierSourceId, supplier.id),
                eq(products.supplierProductId, p.supplierProductId),
              ),
            )
            .limit(1);

          const costStr = p.priceVnd.toFixed(2);
          const markupPct = supplier.markupPercentage || '0.00';
          const markupFixed = supplier.markupFixedVnd || '0.00';

          if (!existingProduct) {
            // INSERT: New product
            const slug = await generateUniqueSlug(p.name || p.title, tx);
            const price = computeRetailPrice(costStr, markupPct, markupFixed);

            await tx.insert(products).values({
              title: (p.title || p.name).slice(0, 255),
              slug,
              description: p.description ? p.description.slice(0, 4000) : null,
              price,
              sourcingMode: 'IN_HOUSE',
              isActive: false,
              autoPricing: true,
              supplierSourceId: supplier.id,
              supplierProductId: p.supplierProductId,
              stock: p.stock,
              upstreamCost: costStr,
              costSyncedAt: new Date(),
            });
          } else {
            // UPDATE: Existing product
            // NEVER update isActive (preserve admin publish state)
            // NEVER update slug (preserve permanent URL)
            const updateData: Partial<typeof products.$inferInsert> = {
              upstreamCost: costStr,
              costSyncedAt: new Date(),
              stock: p.stock,
              updatedAt: new Date(),
            };

            if (existingProduct.autoPricing) {
              updateData.price = computeRetailPrice(costStr, markupPct, markupFixed);
            }

            if (!existingProduct.isActive) {
              // Draft product: update title and description
              updateData.title = (p.title || p.name).slice(0, 255);
              updateData.description = p.description ? p.description.slice(0, 4000) : null;
            }

            await tx
              .update(products)
              .set(updateData)
              .where(eq(products.id, existingProduct.id));
          }
        }
      });

      // 5. Sync success: reset failures and update timestamps
      await this.db
        .update(supplierSources)
        .set({
          lastSyncAt: new Date(),
          lastSyncError: null,
          consecutiveSyncFailures: 0,
          updatedAt: new Date(),
        })
        .where(eq(supplierSources.id, supplier.id));

      this.logger.log(
        `Successfully synced catalog for supplier "${supplier.name}" (${supplier.id}): ${uniqueProducts.length} products upserted.`,
      );

      return { ok: true, productsCount: uniqueProducts.length };
    } catch (err: any) {
      const lastSyncError = err?.message || String(err);
      const newFailures = (supplier.consecutiveSyncFailures ?? 0) + 1;

      this.logger.error(
        `Catalog sync failed for supplier "${supplier.name}" (${supplier.id}) (attempt ${newFailures}): ${lastSyncError}`,
      );

      // Track failure in database
      await this.db
        .update(supplierSources)
        .set({
          lastSyncAt: new Date(),
          lastSyncError,
          consecutiveSyncFailures: newFailures,
          updatedAt: new Date(),
        })
        .where(eq(supplierSources.id, supplier.id));

      // Throttled admin alert: strictly only on the 3rd consecutive failure
      if (newFailures === 3) {
        const alertMsg = `Đồng bộ danh mục thất bại 3 lần liên tiếp cho nhà cung cấp "${supplier.name}" (${supplier.id}): ${lastSyncError}`;
        try {
          await this.db.insert(adminAlerts).values({
            type: AdminAlertType.CATALOG_SYNC_FAILED,
            severity: 'WARN',
            supplierSourceId: supplier.id,
            message: alertMsg,
            payload: {
              supplierId: supplier.id,
              consecutiveSyncFailures: 3,
              lastSyncError,
            },
          });
        } catch (alertDbErr: any) {
          this.logger.error(
            `Failed to insert admin alert for supplier ${supplier.id}: ${alertDbErr?.message || String(alertDbErr)}`,
          );
        }

        try {
          await this.telegramBotService.sendAdminAlert(alertMsg);
        } catch (alertTgErr: any) {
          this.logger.error(
            `Failed to send telegram admin alert for supplier ${supplier.id}: ${alertTgErr?.message || String(alertTgErr)}`,
          );
        }
      }

      // Debounce Lock Release on Failure: immediately clear Redis debounce lock
      await this.clearDebounce(supplier.id);

      throw err;
    }
  }

  /**
   * Clear the Redis debounce lock for a supplier.
   */
  async clearDebounce(supplierId: string): Promise<void> {
    const debounceKey = `catalog-sync:debounce:${supplierId}`;
    try {
      await this.redisService.getClient().del(debounceKey);
    } catch (err: any) {
      this.logger.warn(
        `Failed to clear debounce lock for supplier ${supplierId}: ${err?.message || String(err)}`,
      );
    }
  }
}
