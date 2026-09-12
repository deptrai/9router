import {
  Injectable,
  Inject,
  Optional,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  db,
  orders,
  products,
  users,
  wallets,
  supplierOrders,
  eq,
  and,
  lt,
  asc,
} from '@repo/database';
import {
  OrderStatus,
  SupplierOrderStatus,
  LedgerType,
  OrderDto,
} from '@repo/shared-types';
import { LedgerService } from '../ledger/ledger.service';
import { TelegramBotService } from '../../common/telegram/telegram-bot.service';
import { assertValidOrderTransition } from './order-state-machine';

function toOrderDto(
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

@Injectable()
export class SourcingTimeoutService {
  private readonly logger = new Logger(SourcingTimeoutService.name);
  private readonly ledgerService: LedgerService;
  private readonly telegramBotService: TelegramBotService;
  private readonly dbClient: any;

  constructor(
    @Inject(LedgerService)
    arg1: any,
    @Inject(TelegramBotService)
    @Optional()
    arg2?: any,
    @Optional()
    arg3?: any,
  ) {
    if (arg1 && (arg1.transaction || arg1.query || arg1.select)) {
      this.dbClient = arg1;
      this.ledgerService = arg2;
      this.telegramBotService = arg3;
    } else {
      this.ledgerService = arg1;
      this.telegramBotService = arg2;
      this.dbClient = arg3 ?? db;
    }
  }

  async cancelAndRefund(
    orderId: string,
    reason: string = 'SOURCING_TIMEOUT_60S',
    source: 'DELAYED_TIMEOUT' | 'SWEEPER' | 'TERMINAL_FAILURE' = 'DELAYED_TIMEOUT',
  ): Promise<{ refunded: boolean; order?: OrderDto }> {
    const order = await this.findOrder(orderId);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.status !== OrderStatus.SOURCING) {
      this.logger.log(
        `Order ${orderId} status is ${order.status} (not SOURCING) — skipping cancelAndRefund`,
      );
      return { refunded: false, order: toOrderDto(order) };
    }

    assertValidOrderTransition(order.status as OrderStatus, OrderStatus.REFUNDED);

    const [product, user] = await Promise.all([
      this.findProduct(order.productId),
      this.findUser(order.userId),
    ]);

    let refundedOrder: typeof orders.$inferSelect | undefined;

    await this.dbClient.transaction(async (tx: any) => {
      // 1. Status guard atomic update
      const updateQuery = tx.update ? tx.update(orders) : tx;
      const [updated] = await updateQuery
        .set({ status: OrderStatus.REFUNDED })
        .where(and(eq(orders.id, orderId), eq(orders.status, OrderStatus.SOURCING)))
        .returning();

      if (!updated) {
        // Race lost: order was fulfilled or refunded concurrently
        return;
      }

      // 2. Lock wallet
      let wallet: any;
      if (tx.select) {
        const [w] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.userId, order.userId))
          .for('update');
        wallet = w;
      } else if (tx.execute) {
        const rows = await tx.execute();
        wallet = rows?.[0];
      }

      if (!wallet) {
        throw new Error(`Wallet not found for user ${order.userId}`);
      }

      // 3. Double-entry ledger credit (100% refund)
      const idempotencyKey = `sourcing-refund:${order.id}`;
      await this.ledgerService.credit(
        wallet.id,
        order.price,
        LedgerType.PURCHASE_REFUND,
        idempotencyKey,
        order.id,
        tx,
      );

      // 4. Audit trail
      const insertQuery = tx.insert ? tx.insert(supplierOrders) : tx;
      await insertQuery.values({
        orderId: order.id,
        supplierSourceId: product?.supplierSourceId ?? null,
        status: SupplierOrderStatus.FAILED,
        errorMessage: `${reason}:${source}`,
        completedAt: new Date(),
      });

      refundedOrder = updated;
    });

    if (!refundedOrder) {
      return { refunded: false };
    }

    const orderDto = toOrderDto(refundedOrder, product?.title);

    // 5. Post-commit Telegram notifications (fire-and-forget)
    if (user?.telegramId && this.telegramBotService?.sendRefundNotice) {
      const productTitle = product?.title ?? 'Sản phẩm';
      void this.telegramBotService
        .sendRefundNotice(user.telegramId, orderDto, productTitle)
        .catch((err) => {
          this.logger.warn(`Failed to send refund notice for order ${order.id}: ${err.message || err}`);
        });
    }

    if (source === 'SWEEPER' && this.telegramBotService?.sendAdminAlert) {
      void this.telegramBotService
        .sendAdminAlert(
          `⚠️ Đơn hàng #${order.id.slice(0, 8)} đã được giải cứu và hoàn tiền do quá hạn xử lý 60s.`,
        )
        .catch((err) => {
          this.logger.warn(`Failed to send admin alert: ${err.message || err}`);
        });
    }

    return { refunded: true, order: orderDto };
  }

  async sweepExpiredOrders(timeoutSeconds: number = 60): Promise<number> {
    const cutoff = new Date(Date.now() - timeoutSeconds * 1000);

    let expiredOrders: any[] = [];
    if (this.dbClient.select) {
      const query = this.dbClient
        .select()
        .from(orders)
        .where(and(eq(orders.status, OrderStatus.SOURCING), lt(orders.createdAt, cutoff)));

      const orderedQuery = typeof query.orderBy === 'function' ? query.orderBy(asc(orders.createdAt)) : query;
      expiredOrders = typeof orderedQuery.limit === 'function' ? await orderedQuery.limit(50) : await orderedQuery;
    }

    let count = 0;
    for (const exp of expiredOrders) {
      try {
        const res = await this.cancelAndRefund(
          exp.id,
          'SOURCING_SWEEPER_TIMEOUT_60S',
          'SWEEPER',
        );
        if (res.refunded) {
          count++;
        }
      } catch (err: any) {
        this.logger.error(
          `Sweeper failed to cancel/refund order ${exp.id}: ${err?.message || err}`,
        );
      }
    }

    if (count > 0 && this.telegramBotService?.sendAdminAlert) {
      void this.telegramBotService
        .sendAdminAlert(
          `⚠️ Sweeper đã giải cứu và hoàn tiền cho ${count} đơn hàng SOURCING quá hạn 60s.`,
        )
        .catch((err) => {
          this.logger.warn(`Failed to send sweeper admin alert: ${err.message || err}`);
        });
    }

    return count;
  }

  private async findOrder(orderId: string): Promise<typeof orders.$inferSelect | null> {
    if (this.dbClient.query?.orders?.findFirst) {
      return this.dbClient.query.orders.findFirst({ where: eq(orders.id, orderId) });
    }
    const [order] = await this.dbClient.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    return order ?? null;
  }

  private async findProduct(productId: string): Promise<typeof products.$inferSelect | null> {
    if (this.dbClient.query?.products?.findFirst) {
      return this.dbClient.query.products.findFirst({ where: eq(products.id, productId) });
    }
    const [prod] = await this.dbClient.select().from(products).where(eq(products.id, productId)).limit(1);
    return prod ?? null;
  }

  private async findUser(userId: string): Promise<typeof users.$inferSelect | null> {
    if (this.dbClient.query?.users?.findFirst) {
      return this.dbClient.query.users.findFirst({ where: eq(users.id, userId) });
    }
    const [u] = await this.dbClient.select().from(users).where(eq(users.id, userId)).limit(1);
    return u ?? null;
  }
}
