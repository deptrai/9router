import {
  Injectable,
  Inject,
  Optional,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import {
  db,
  orders,
  products,
  users,
  wallets,
  supplierOrders,
  supplierSources,
  ledgerTransactions,
  productInventory,
  eq,
  and,
  or,
  desc,
  sql,
  ilike,
  inArray,
  type DbOrTx,
} from '@repo/database';
import {
  OrderStatus,
  LedgerType,
  InventoryStatus,
  ProductSourcingMode,
  OrderDto,
  AdminOrderListItemDto,
  AdminOrderDetailDto,
  AdminManualRefundResponseDto,
  ListAdminOrdersQueryDto,
} from '@repo/shared-types';
import { LedgerService } from '../ledger/ledger.service';
import { TelegramBotService } from '../../common/telegram/telegram-bot.service';
import { maskCredential } from '../inventory/utils/credential-mask.util';
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

/**
 * Service dedicated exclusively to Administrative Order Operations (SRP compliance).
 * Isolates admin listing, details inspection, credential revealing, and manual refunding
 * from the high-throughput customer checkout order lifecycle.
 */
@Injectable()
export class AdminOrdersService {
  private readonly logger = new Logger(AdminOrdersService.name);
  private readonly ledgerService: LedgerService;
  private readonly telegramBotService?: TelegramBotService;
  private readonly dbClient: DbOrTx;

  constructor(
    @Inject(LedgerService)
    ledgerService: LedgerService,
    @Optional()
    @Inject(TelegramBotService)
    telegramBotService?: TelegramBotService,
    @Optional()
    dbClient?: DbOrTx,
  ) {
    this.ledgerService = ledgerService;
    this.telegramBotService = telegramBotService;
    this.dbClient = dbClient ?? db;
  }

  /**
   * Lists all customer orders with filtering (status, productId, search) and pagination.
   */
  async listAdminOrders(
    query: ListAdminOrdersQueryDto,
    tx: DbOrTx = this.dbClient,
  ): Promise<{ orders: AdminOrderListItemDto[]; total: number }> {
    const limit = Math.min(query.limit ?? 50, 100);
    const offset = query.offset ?? 0;
    const { status, search, productId } = query;

    const conditions = [];

    if (status) {
      conditions.push(eq(orders.status, status));
    }

    if (productId) {
      conditions.push(eq(orders.productId, productId));
    }

    if (search && search.trim()) {
      const q = search.trim();
      conditions.push(
        or(
          sql`${orders.id}::text ILIKE ${'%' + q + '%'}`,
          sql`${users.telegramId}::text ILIKE ${'%' + q + '%'}`,
          ilike(users.username, '%' + q + '%'),
        )!,
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countResult] = await Promise.all([
      tx
        .select({
          order: orders,
          user: users,
          product: products,
          supplier: supplierSources,
        })
        .from(orders)
        .innerJoin(users, eq(orders.userId, users.id))
        .innerJoin(products, eq(orders.productId, products.id))
        .leftJoin(supplierSources, eq(products.supplierSourceId, supplierSources.id))
        .where(whereClause)
        .orderBy(desc(orders.createdAt))
        .limit(limit)
        .offset(offset),
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .innerJoin(users, eq(orders.userId, users.id))
        .innerJoin(products, eq(orders.productId, products.id))
        .where(whereClause),
    ]);

    const mapped: AdminOrderListItemDto[] = rows.map((r) => ({
      id: r.order.id,
      userId: r.order.userId,
      telegramId: r.user.telegramId,
      username: r.user.username,
      productId: r.order.productId,
      productTitle: r.product.title,
      price: r.order.price,
      status: r.order.status as OrderStatus,
      sourcingMode: r.product.sourcingMode as ProductSourcingMode,
      supplierName: r.supplier?.name ?? null,
      createdAt:
        r.order.createdAt instanceof Date
          ? r.order.createdAt.toISOString()
          : String(r.order.createdAt),
      fulfilledAt: r.order.fulfilledAt
        ? r.order.fulfilledAt instanceof Date
          ? r.order.fulfilledAt.toISOString()
          : String(r.order.fulfilledAt)
        : null,
    }));

    return {
      orders: mapped,
      total: Number(countResult[0]?.count ?? 0),
    };
  }

  /**
   * Retrieves full details for an order including customer info, product info,
   * supplier order traces, and related ledger transactions.
   */
  async getAdminOrderDetail(
    orderId: string,
    tx: DbOrTx = this.dbClient,
  ): Promise<AdminOrderDetailDto> {
    const [row] = await tx
      .select({
        order: orders,
        user: users,
        wallet: wallets,
        product: products,
      })
      .from(orders)
      .innerJoin(users, eq(orders.userId, users.id))
      .leftJoin(wallets, eq(users.id, wallets.userId))
      .innerJoin(products, eq(orders.productId, products.id))
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'ORDER_NOT_FOUND',
        message: `Order ${orderId} not found`,
      });
    }

    const traces = await tx
      .select({
        trace: supplierOrders,
        supplierName: supplierSources.name,
      })
      .from(supplierOrders)
      .leftJoin(supplierSources, eq(supplierOrders.supplierSourceId, supplierSources.id))
      .where(eq(supplierOrders.orderId, orderId))
      .orderBy(desc(supplierOrders.createdAt));

    const ledgerRows = await tx
      .select()
      .from(ledgerTransactions)
      .where(
        or(
          eq(ledgerTransactions.referenceId, orderId),
          sql`${ledgerTransactions.metadata}->>'orderId' = ${orderId}`,
        ),
      )
      .orderBy(desc(ledgerTransactions.createdAt));

    let maskedDelivered = row.order.deliveredCredential;
    if (maskedDelivered) {
      maskedDelivered = maskCredential(maskedDelivered);
    }

    const orderDto: OrderDto = {
      ...toOrderDto(row.order, row.product.title),
      deliveredCredential: maskedDelivered,
    };

    return {
      order: orderDto,
      customer: {
        id: row.user.id,
        telegramId: row.user.telegramId,
        username: row.user.username,
        firstName: row.user.firstName,
        lastName: row.user.lastName,
        walletBalance: row.wallet?.balance ?? '0.00',
      },
      product: {
        id: row.product.id,
        title: row.product.title,
        slug: row.product.slug,
        price: row.product.price,
        sourcingMode: row.product.sourcingMode as ProductSourcingMode,
        category: row.product.category,
      },
      supplierTraces: traces.map((t) => ({
        id: t.trace.id,
        orderId: t.trace.orderId,
        supplierName: t.supplierName ?? null,
        externalOrderId: t.trace.externalOrderId,
        cost: t.trace.cost,
        status: t.trace.status,
        rawPayload: t.trace.rawPayload,
        errorMessage: t.trace.errorMessage,
        createdAt:
          t.trace.createdAt instanceof Date
            ? t.trace.createdAt.toISOString()
            : String(t.trace.createdAt),
        completedAt: t.trace.completedAt
          ? t.trace.completedAt instanceof Date
            ? t.trace.completedAt.toISOString()
            : String(t.trace.completedAt)
          : null,
      })),
      ledgerTransactions: ledgerRows.map((lt) => ({
        id: lt.id,
        walletId: lt.walletId,
        type: lt.type as LedgerType,
        amount: lt.amount,
        balanceBefore: lt.balanceBefore,
        balanceAfter: lt.balanceAfter,
        referenceId: lt.referenceId,
        idempotencyKey: lt.idempotencyKey,
        metadata: lt.metadata,
        createdAt:
          lt.createdAt instanceof Date
            ? lt.createdAt.toISOString()
            : String(lt.createdAt),
      })),
    };
  }

  /**
   * Reveals the plaintext delivered credential for admin audit purposes.
   * Logs an [AUDIT] entry tracking which admin revealed which order.
   */
  async revealAdminCredential(
    orderId: string,
    adminId: string,
  ): Promise<{ ok: boolean; plaintext: string }> {
    const [order] = await this.dbClient
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'ORDER_NOT_FOUND',
        message: `Order ${orderId} not found`,
      });
    }

    if (!order.deliveredCredential) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'NO_CREDENTIAL_DELIVERED',
        message: `Order ${orderId} has no delivered credential`,
      });
    }

    this.logger.log(
      `[AUDIT] Admin ${adminId} revealed delivered credential for order ${orderId}`,
    );

    return {
      ok: true,
      plaintext: order.deliveredCredential,
    };
  }

  /**
   * Manually refunds an order in PAID, SOURCING, or FULFILLED status.
   * Atomically transitions state to REFUNDED, credits user wallet via LedgerService,
   * optionally marks delivered in-house credential as DEFECTIVE, and logs an audit record.
   */
  async adminManualRefund(
    orderId: string,
    adminId: string,
    reason: string,
    markCredentialDefective: boolean = false,
    tx: DbOrTx = this.dbClient,
  ): Promise<AdminManualRefundResponseDto> {
    const ensureTx = async <T>(fn: (runner: DbOrTx) => Promise<T>): Promise<T> => {
      if (tx === db) {
        return (db as any).transaction(fn);
      }
      return fn(tx);
    };

    return ensureTx(async (runner) => {
      const [order] = await runner
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update')
        .limit(1);

      if (!order) {
        throw new NotFoundException({
          statusCode: 404,
          errorCode: 'ORDER_NOT_FOUND',
          message: `Order ${orderId} not found`,
        });
      }

      if (order.status === OrderStatus.REFUNDED) {
        throw new ConflictException({
          statusCode: 409,
          errorCode: 'ORDER_ALREADY_REFUNDED',
          message: 'Order has already been refunded',
        });
      }

      if (![OrderStatus.PAID, OrderStatus.SOURCING, OrderStatus.FULFILLED].includes(order.status as OrderStatus)) {
        throw new ConflictException({
          statusCode: 409,
          errorCode: 'ORDER_CANNOT_BE_REFUNDED',
          message: `Cannot refund order in status ${order.status}. Only PAID, SOURCING, or FULFILLED orders can be refunded.`,
        });
      }

      assertValidOrderTransition(order.status as OrderStatus, OrderStatus.REFUNDED);

      const [wallet] = await runner
        .select()
        .from(wallets)
        .where(eq(wallets.userId, order.userId))
        .for('update')
        .limit(1);

      if (!wallet) {
        throw new NotFoundException({
          statusCode: 404,
          errorCode: 'WALLET_NOT_FOUND',
          message: `Wallet for user ${order.userId} not found`,
        });
      }

      const [updatedOrder] = await runner
        .update(orders)
        .set({ status: OrderStatus.REFUNDED })
        .where(
          and(
            eq(orders.id, orderId),
            inArray(orders.status, [OrderStatus.PAID, OrderStatus.SOURCING, OrderStatus.FULFILLED]),
          ),
        )
        .returning();

      if (!updatedOrder) {
        throw new ConflictException({
          statusCode: 409,
          errorCode: 'ORDER_CONCURRENT_STATE_CHANGE',
          message: 'Order status changed concurrently',
        });
      }

      const idempotencyKey = `${orderId}:admin-refund`;
      await this.ledgerService.credit(
        wallet.id,
        order.price,
        LedgerType.PURCHASE_REFUND,
        idempotencyKey,
        order.id,
        runner,
        {
          reason,
          adminId,
          source: 'ADMIN_MANUAL_REFUND',
          markCredentialDefective,
        },
      );

      if (markCredentialDefective) {
        await runner
          .update(productInventory)
          .set({ status: InventoryStatus.DEFECTIVE })
          .where(eq(productInventory.orderId, orderId));
      }

      this.logger.log(
        `[AUDIT] Admin ${adminId} manually refunded order ${orderId} (${order.price} VND). Reason: "${reason}"`,
      );

      return {
        ok: true,
        refunded: true,
        orderId: order.id,
        refundedAmount: order.price,
        refundedAt: new Date().toISOString(),
        userId: order.userId,
        productId: order.productId,
      };
    });
  }

  /**
   * Sends post-commit Telegram notification for manual refund.
   * Must be called AFTER the transaction commits to avoid holding FOR UPDATE locks
   * during external HTTP calls.
   */
  async notifyRefundCommit(
    userId: string,
    productId: string,
    updatedOrder: OrderDto,
  ): Promise<void> {
    if (!this.telegramBotService) return;
    try {
      const [user] = await this.dbClient.select().from(users).where(eq(users.id, userId)).limit(1);
      const [product] = await this.dbClient.select().from(products).where(eq(products.id, productId)).limit(1);
      if (user && product) {
        await this.telegramBotService.sendRefundNotice(
          user.telegramId,
          updatedOrder,
          product.title,
        );
      }
    } catch (err: any) {
      this.logger.warn(`Failed to send Telegram refund notice for order ${updatedOrder.id}: ${err?.message}`);
    }
  }
}
