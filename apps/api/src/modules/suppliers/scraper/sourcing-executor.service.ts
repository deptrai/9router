import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Queue, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import {
  db,
  orders,
  products,
  productInventory,
  supplierSources,
  supplierOrders,
  wallets,
  users,
  encryptCredential,
  eq,
  and,
} from '@repo/database';
import {
  OrderStatus,
  SupplierOrderStatus,
  LedgerType,
  InventoryStatus,
  parseSignedDecimal,
  SourcingJobData,
  OrderDto,
} from '@repo/shared-types';
import { AdapterRegistryService } from './adapters/adapter.registry';
import {
  SupplierTerminalError,
  SupplierRetryableError,
  PurchaseResult,
} from './adapters/supplier-adapter';
import { SupplierPriceFetcherService } from '../../products/supplier-price-fetcher.service';
import { LedgerService } from '../../ledger/ledger.service';
import { TelegramBotService } from '../../../common/telegram/telegram-bot.service';
import { SourcingTimeoutScheduler } from '../../../workers/sourcing-timeout.scheduler';

@Injectable()
export class SourcingExecutorService {
  private readonly logger = new Logger(SourcingExecutorService.name);

  constructor(
    @Inject(AdapterRegistryService)
    private readonly adapterRegistry: AdapterRegistryService,
    @Inject(SupplierPriceFetcherService)
    private readonly priceFetcher: SupplierPriceFetcherService,
    @Inject(LedgerService)
    private readonly ledgerService: LedgerService,
    @Inject(TelegramBotService)
    private readonly telegramBot: TelegramBotService,
    @Optional()
    @Inject(SourcingTimeoutScheduler)
    private readonly timeoutScheduler?: SourcingTimeoutScheduler,
  ) {}

  async execute(
    job: Job<SourcingJobData> | { data: SourcingJobData; attemptsMade?: number; opts?: { attempts?: number } },
  ): Promise<void> {
    const { orderId, supplierSourceId } = job.data;

    // 1. Read order + check status
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));

    if (!order || order.status !== OrderStatus.SOURCING) {
      this.logger.log(
        `Order ${orderId} not found or status (${order?.status}) is not SOURCING — discarding job`,
      );
      return;
    }

    // 2. Read product & buyer
    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, order.productId));

    const [buyer] = await db
      .select()
      .from(users)
      .where(eq(users.id, order.userId));

    if (!product) {
      return this.terminalFail(order, 'PRODUCT_MISSING', undefined, buyer, undefined);
    }

    // 3. Resolve supplier
    const targetSupplierId = supplierSourceId ?? product.supplierSourceId;
    const [supplier] = targetSupplierId
      ? await db
          .select()
          .from(supplierSources)
          .where(eq(supplierSources.id, targetSupplierId))
      : [undefined];

    if (!supplier || !supplier.isActive) {
      return this.terminalFail(order, 'SUPPLIER_INVALID', supplier, buyer, product);
    }

    const creds = supplier.configCredentials;
    if (!creds || typeof creds !== 'object' || Object.keys(creds).length === 0) {
      return this.terminalFail(order, 'SUPPLIER_INVALID', supplier, buyer, product);
    }

    // 4. Resolve adapter
    const adapter = this.adapterRegistry.get(supplier.type);
    if (!adapter) {
      return this.terminalFail(
        order,
        `ADAPTER_MISSING:${supplier.type}`,
        supplier,
        buyer,
        product,
      );
    }

    // 5. Margin re-check
    let costStr: string;
    try {
      costStr = await this.priceFetcher.fetchUpstreamCost(product, supplier);
    } catch {
      return this.terminalFail(order, 'COST_UNAVAILABLE', supplier, buyer, product);
    }

    try {
      const cost = parseSignedDecimal(costStr);
      const orderPrice = parseSignedDecimal(order.price);
      const maxCost =
        product.maxUpstreamCost != null
          ? parseSignedDecimal(product.maxUpstreamCost)
          : null;

      if ((maxCost != null && cost > maxCost) || cost > orderPrice) {
        return this.terminalFail(order, 'MARGIN_BREACH', supplier, buyer, product);
      }
    } catch {
      return this.terminalFail(order, 'COST_UNAVAILABLE', supplier, buyer, product);
    }

    // 6 & 7. Execute purchase with timeout & 2-phase commit in DB transaction
    try {
      const timeoutMs = Math.max(1, Number(process.env.SOURCING_PURCHASE_TIMEOUT_MS) || 45_000);
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new SupplierRetryableError(`Purchase timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const purchaseP = adapter.purchase(product, supplier);
      purchaseP.catch(() => {}); // prevent unhandledRejection if timeoutPromise wins

      let purchaseRes: PurchaseResult;
      try {
        purchaseRes = await Promise.race([
          purchaseP,
          timeoutPromise,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      // Early check before opening transaction: hint credential must be a valid non-empty string
      const earlyCred = purchaseRes?.credential;
      if (typeof earlyCred !== 'string' || !earlyCred.trim()) {
        throw new SupplierTerminalError('INVALID_OUTPUT');
      }

      let committed = false;
      let fulfilledOrder: typeof orders.$inferSelect | undefined;

      await db.transaction(async (tx) => {
        // a. Reserve order — status guard; empty-commit nếu thua race
        const [reserved] = await tx
          .update(orders)
          .set({ status: OrderStatus.FULFILLED })
          .where(and(eq(orders.id, order.id), eq(orders.status, OrderStatus.SOURCING)))
          .returning();

        // b. Consume supplier state NGUYÊN TỬ (FOR UPDATE trong commit — serialize per-supplier)
        let finalRes = purchaseRes;
        if (adapter.commit) {
          finalRes = await adapter.commit(supplier.id, purchaseRes, tx);
        }

        // c. Validate credential (AC #6)
        const rawCred = finalRes?.credential;
        const trimmedCred = typeof rawCred === 'string' ? rawCred.trim() : '';
        if (reserved && (!trimmedCred || trimmedCred.length > 2000 || trimmedCred.includes('\0'))) {
          throw new SupplierTerminalError('INVALID_OUTPUT');
        }

        const costVal =
          finalRes.cost && /^\d+(\.\d{1,2})?$/.test(finalRes.cost)
            ? finalRes.cost
            : (costStr ?? null);

        if (!reserved) {
          // Race lost: sweeper or timeout refunded order while scraper was purchasing.
          // Recover purchased credential into internal inventory so company funds are preserved.
          if (trimmedCred && trimmedCred.length <= 2000 && !trimmedCred.includes('\0')) {
            await tx.insert(productInventory).values({
              productId: product.id,
              credentialData: encryptCredential(trimmedCred),
              status: InventoryStatus.AVAILABLE,
            });
            await tx.insert(supplierOrders).values({
              orderId: order.id,
              supplierSourceId: supplier.id,
              externalOrderId: finalRes.externalOrderId ? String(finalRes.externalOrderId).slice(0, 255) : null,
              cost: costVal,
              status: SupplierOrderStatus.SUCCESS,
              rawPayload: { note: 'ORPHANED_CREDENTIAL_RECOVERED_TO_INVENTORY_AFTER_TIMEOUT' },
              completedAt: new Date(),
            });
            this.logger.warn(`Order ${order.id} was refunded by timeout; recovered credential into inventory for product ${product.id}`);
            if (this.telegramBot?.sendAdminAlert) {
              void this.telegramBot.sendAdminAlert(
                `⚠️ Đơn hàng #${order.id.slice(0, 8)} đã hoàn tiền cho khách do timeout 60s, credential mua ngoài đã được tự động thu hồi về kho nội bộ.`,
              ).catch(() => {});
            }
          }
          return;
        }

        // d. Ghi credential + audit
        const [updated] = await tx
          .update(orders)
          .set({
            deliveredCredential: trimmedCred,
            fulfilledAt: new Date(),
          })
          .where(eq(orders.id, order.id))
          .returning();

        await tx.insert(supplierOrders).values({
          orderId: order.id,
          supplierSourceId: supplier.id,
          externalOrderId: finalRes.externalOrderId
            ? String(finalRes.externalOrderId).slice(0, 255)
            : null,
          cost: costVal,
          status: SupplierOrderStatus.SUCCESS,
          rawPayload: finalRes.rawPayload ? (finalRes.rawPayload as any) : null,
          completedAt: new Date(),
        });

        committed = true;
        fulfilledOrder =
          updated ?? {
            ...reserved,
            deliveredCredential: trimmedCred,
            fulfilledAt: new Date(),
          };
      });

      if (committed && fulfilledOrder) {
        // Cancel 60s delayed timeout job since order was fulfilled successfully
        if (this.timeoutScheduler) {
          void this.timeoutScheduler.cancelTimeout(order.id).catch(() => {});
        }

        if (buyer?.telegramId) {
          const orderDto = this.toOrderDto(fulfilledOrder, product.title);
          this.telegramBot
            .sendOrderConfirmation(buyer.telegramId, orderDto, product.title)
            .catch((err) => {
              this.logger.warn(`Failed to send order confirmation: ${err?.message ?? err}`);
            });
        }
      }
    } catch (err: any) {
      if (err instanceof SupplierTerminalError) {
        return this.terminalFail(order, err.message, supplier, buyer, product);
      }

      const maxAttempts = job.opts?.attempts ?? 3;
      const attemptsMade = job.attemptsMade ?? 0;
      if (attemptsMade + 1 >= maxAttempts) {
        return this.terminalFail(
          order,
          `RETRY_EXHAUSTED:${err?.message ?? String(err)}`,
          supplier,
          buyer,
          product,
        );
      }

      throw err;
    }
  }

  private async terminalFail(
    order: typeof orders.$inferSelect,
    reason: string,
    supplier?: typeof supplierSources.$inferSelect,
    buyer?: typeof users.$inferSelect,
    product?: typeof products.$inferSelect,
  ): Promise<void> {
    this.logger.warn(`Terminal failure for order ${order.id}: ${reason}`);
    let refundedOrder: typeof orders.$inferSelect | undefined;

    await db.transaction(async (tx) => {
      // 1. Status-guard UPDATE orders SET status = 'REFUNDED' WHERE id = ? AND status = 'SOURCING'
      const [updated] = await tx
        .update(orders)
        .set({ status: OrderStatus.REFUNDED })
        .where(and(eq(orders.id, order.id), eq(orders.status, OrderStatus.SOURCING)))
        .returning();

      if (!updated) {
        // Race-lost: đã refund hoặc fulfill trước (AC #8)
        return;
      }

      // 2. Lookup wallet of user
      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.userId, order.userId))
        .for('update');

      if (!wallet) {
        throw new Error('WALLET_MISSING');
      }

      // 3. Ledger credit (PURCHASE_REFUND)
      const refundIdempotencyKey = `sourcing-refund:${order.id}`;
      await this.ledgerService.credit(
        wallet.id,
        order.price,
        LedgerType.PURCHASE_REFUND,
        refundIdempotencyKey,
        order.id,
        tx,
      );

      // 4. Audit row in supplier_orders (supplierSourceId null safe)
      await tx.insert(supplierOrders).values({
        orderId: order.id,
        supplierSourceId: supplier?.id ?? null,
        status: SupplierOrderStatus.FAILED,
        errorMessage: reason,
        completedAt: new Date(),
      });

      refundedOrder = updated;
    });

    // 5. Post-commit refund notice via Telegram (fire-and-forget)
    if (refundedOrder) {
      let buyerUser = buyer;
      if (!buyerUser) {
        const [b] = await db.select().from(users).where(eq(users.id, order.userId));
        buyerUser = b;
      }

      if (buyerUser?.telegramId) {
        const productTitle = product?.title ?? 'Sản phẩm';
        const orderDto = this.toOrderDto(refundedOrder, productTitle);
        this.telegramBot
          .sendRefundNotice(buyerUser.telegramId, orderDto, productTitle)
          .catch((e) => {
            this.logger.warn(`Failed to send refund notice: ${e?.message ?? e}`);
          });
      }
    } else {
      this.logger.log(
        `Order ${order.id} was already resolved by another process — skipping terminal refund`,
      );
      return;
    }

    // 6. Throw UnrecoverableError
    throw new UnrecoverableError(reason);
  }

  private toOrderDto(
    record: typeof orders.$inferSelect,
    productTitle?: string,
  ): OrderDto {
    return {
      id: record.id,
      userId: record.userId,
      productId: record.productId,
      status: record.status as OrderStatus,
      price: record.price,
      productTitle,
      deliveredCredential: record.deliveredCredential ?? null,
      idempotencyKey: record.idempotencyKey ?? null,
      createdAt:
        record.createdAt instanceof Date
          ? record.createdAt.toISOString()
          : String(record.createdAt),
      fulfilledAt: record.fulfilledAt
        ? record.fulfilledAt instanceof Date
          ? record.fulfilledAt.toISOString()
          : String(record.fulfilledAt)
        : null,
    };
  }
}
