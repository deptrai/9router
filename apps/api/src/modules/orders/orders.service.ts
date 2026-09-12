import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  db,
  desc,
  eq,
  and,
  sql,
  inArray,
  orders,
  products,
  supplierSources,
  type DbOrTx,
} from '@repo/database';
import {
  OrderStatus,
  LedgerType,
  ProductSourcingMode,
  parseSignedDecimal,
  formatSignedDecimal,
  type OrderDto,
  type CheckoutResponseDto,
  type TelegramUserDto,
  type SourcingJobData,
} from '@repo/shared-types';
import { RedisService, RedisUnavailableError } from '../../common/redis/redis.service';
import { LedgerService } from '../ledger/ledger.service';
import { InventoryService } from '../inventory/inventory.service';
import { WalletsService } from '../wallets/wallets.service';
import { UsersService } from '../users/users.service';
import { TelegramBotService } from '../../common/telegram/telegram-bot.service';
import { SourcingQueueService } from '../suppliers/sourcing-queue.service';
import { InsufficientFundsException } from '../../common/exceptions/insufficient-funds.exception';

type OrderRecord = typeof orders.$inferSelect;

function toOrderDto(record: OrderRecord, productTitle?: string): OrderDto {
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
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly ledgerService: LedgerService,
    private readonly inventoryService: InventoryService,
    private readonly walletsService: WalletsService,
    private readonly usersService: UsersService,
    private readonly telegramBotService: TelegramBotService,
    private readonly sourcingQueue: SourcingQueueService,
  ) {}

  /**
   * One-tap checkout: debit wallet + bind credential atomically.
   *
   * Flow:
   * 1. Idempotency check (no locks needed)
   * 2. Resolve telegram user → internal userRecord
   * 3. Acquire Redlock on wallet + inventory
   * 4. Single PG transaction: wallet debit → order PENDING → reserve → confirmSold → FULFILLED
   */
  async checkout(
    telegramUser: TelegramUserDto,
    productId: string,
    idempotencyKey: string,
  ): Promise<CheckoutResponseDto> {
    // Step 1: Idempotency — return existing order without touching locks/DB
    const existing = await this.getOrderByIdempotencyKey(idempotencyKey);
    if (existing) {
      await this.ensureJobForSourcingOrder(existing);
      return {
        ok: true,
        order: existing,
        deliveredCredential: existing.deliveredCredential ?? undefined,
      };
    }

    // Step 2: Resolve user outside lock (needed for lock key)
    const userRecord = await this.usersService.upsertByTelegram(telegramUser);

    // Step 3: Acquire distributed locks
    let result: CheckoutResponseDto;
    // Track productTitle + userRecord.telegramId for post-commit notification
    let productTitleForNotification: string | undefined;
    // Set inside the tx on the SOURCING branch — consumed post-commit to
    // enqueue the sourcing job and, on failure, to compensate the debit.
    let sourcingJobData: SourcingJobData | undefined;
    let sourcingRefundInfo:
      | { walletId: string; orderId: string; amount: string }
      | undefined;
    try {
      result = await this.redisService.withLock(
        [`lock:wallet:${userRecord.id}`, `lock:inventory:${productId}`],
        5000,
        async () => {
          // Double-check idempotency inside lock in case a concurrent request
          // with the same idempotencyKey finished while this request waited for the lock.
          const lockedExisting = await this.getOrderByIdempotencyKey(idempotencyKey);
          if (lockedExisting) {
            return {
              ok: true,
              order: lockedExisting,
              deliveredCredential: lockedExisting.deliveredCredential ?? undefined,
            };
          }

          // Step 4: Single atomic DB transaction
          return db.transaction(async (tx) => {
            // a. Get wallet
            const wallet = await this.walletsService.getOrCreateByUserId(
              userRecord.id,
              tx,
            );

            // b. Get product
            const [product] = await tx
              .select()
              .from(products)
              .where(
                and(
                  eq(products.id, productId),
                  eq(products.isActive, true),
                ),
              )
              .limit(1);

            if (!product) {
              throw new NotFoundException({
                errorCode: 'PRODUCT_NOT_FOUND',
                message: `Product ${productId} not found or inactive`,
              });
            }

            productTitleForNotification = product.title;

            // b2. Duplicate-purchase guard — in-house stock used to provide
            //     this backstop implicitly via OUT_OF_STOCK; external sourcing
            //     removes it, so reject explicitly when the user already has
            //     an in-flight order for the same product.
            const [inFlight] = await tx
              .select({ id: orders.id })
              .from(orders)
              .where(
                and(
                  eq(orders.userId, userRecord.id),
                  eq(orders.productId, productId),
                  inArray(orders.status, [
                    OrderStatus.PENDING,
                    OrderStatus.PAID,
                    OrderStatus.SOURCING,
                  ]),
                ),
              )
              .limit(1);
            if (inFlight) {
              throw new ConflictException({
                errorCode: 'ORDER_IN_PROGRESS',
                message:
                  'An order for this product is already in progress',
              });
            }

            // c. Check balance (BigInt arithmetic — no float)
            const balanceUnits = parseSignedDecimal(String(wallet.balance));
            const priceUnits = parseSignedDecimal(String(product.price));

            if (balanceUnits < priceUnits) {
              const missingAmount = formatSignedDecimal(priceUnits - balanceUnits);
              throw new HttpException(
                {
                  statusCode: HttpStatus.PAYMENT_REQUIRED,
                  errorCode: 'INSUFFICIENT_FUNDS',
                  missingAmount,
                  message: `Insufficient balance. Missing ${missingAmount} VND.`,
                },
                HttpStatus.PAYMENT_REQUIRED,
              );
            }

            // d. Insert order PENDING → get orderId
            //    If a concurrent request with same idempotencyKey already committed,
            //    Postgres raises 23505. Caught in the outer catch block (below)
            //    because the tx is aborted once a statement fails inside it.
            const [order] = await tx
              .insert(orders)
              .values({
                userId: userRecord.id,
                productId,
                price: product.price,
                status: OrderStatus.PENDING,
                idempotencyKey,
              })
              .returning();

            // e. Debit wallet (ledger does FOR UPDATE internally)
            try {
              await this.ledgerService.debit(
                wallet.id,
                product.price,
                LedgerType.STORE_PURCHASE,
                idempotencyKey,
                order.id,
                tx,
              );
            } catch (e) {
              if (e instanceof InsufficientFundsException) {
                const missing = formatSignedDecimal(priceUnits - balanceUnits);
                throw new HttpException(
                  {
                    statusCode: HttpStatus.PAYMENT_REQUIRED,
                    errorCode: 'INSUFFICIENT_FUNDS',
                    missingAmount: missing,
                    message: `Insufficient balance. Missing ${missing} VND.`,
                  },
                  HttpStatus.PAYMENT_REQUIRED,
                );
              }
              throw e;
            }

            // f. Debit committed → order is paid (FR-14 state machine:
            //    PENDING → PAID → FULFILLED | SOURCING)
            await tx
              .update(orders)
              .set({ status: OrderStatus.PAID })
              .where(eq(orders.id, order.id));

            // g. Reserve credential — null = no AVAILABLE in-house item.
            //    If the product can source externally, route to SOURCING
            //    instead of failing with OUT_OF_STOCK (Story 4.2 / FR-12).
            const reserved = await this.inventoryService.reserveCredential(
              productId,
              order.id,
              tx,
            );
            if (!reserved) {
              // Margin guard — do not commit a SOURCING order that would buy
              // upstream at a loss (stale cost between price-sync runs) or
              // already breach the configured maxUpstreamCost ceiling.
              const upstream =
                product.upstreamCost == null
                  ? null
                  : parseSignedDecimal(String(product.upstreamCost));
              const marginOk =
                upstream == null ||
                (upstream <= priceUnits &&
                  (product.maxUpstreamCost == null ||
                    upstream <=
                      parseSignedDecimal(String(product.maxUpstreamCost))));

              const canSource =
                marginOk &&
                (product.sourcingMode === ProductSourcingMode.EXTERNAL ||
                  product.sourcingMode === ProductSourcingMode.HYBRID) &&
                !!product.supplierSourceId &&
                (await this.isSupplierActive(product.supplierSourceId, tx));

              if (!canSource) {
                throw new ConflictException({
                  errorCode: 'OUT_OF_STOCK',
                  message: `Product ${productId} is out of stock`,
                });
              }

              // Fail fast INSIDE the tx when the queue was never initialized:
              // throwing here rolls back the debit — buyer is not charged.
              if (!this.sourcingQueue.isReady()) {
                throw new ServiceUnavailableException({
                  errorCode: 'SOURCING_UNAVAILABLE',
                  message: 'Sourcing queue is not available',
                });
              }

              const [sourcing] = await tx
                .update(orders)
                .set({ status: OrderStatus.SOURCING })
                .where(eq(orders.id, order.id))
                .returning();

              // Do NOT enqueue here — a BullMQ add writes Redis immediately
              // while this row is still uncommitted, so a live worker could
              // pick the job up before the order is visible and discard it
              // (losing a paid order). Enqueue happens post-commit below.
              sourcingJobData = {
                orderId: order.id,
                productId,
                supplierSourceId: product.supplierSourceId as string,
              };
              sourcingRefundInfo = {
                walletId: wallet.id,
                orderId: order.id,
                amount: product.price,
              };

              return {
                ok: true,
                order: toOrderDto(sourcing),
              };
            }

            // h. Confirm sale — get plaintext credential
            const delivered = await this.inventoryService.confirmSold(
              reserved.id,
              order.id,
              tx,
            );

            // i. Update order → FULFILLED
            const [fulfilled] = await tx
              .update(orders)
              .set({
                status: OrderStatus.FULFILLED,
                deliveredCredential: delivered.credentialData,
                fulfilledAt: sql`now()`,
              })
              .where(eq(orders.id, order.id))
              .returning();

            return {
              ok: true,
              order: toOrderDto(fulfilled),
              deliveredCredential: delivered.credentialData,
            };
          });
        },
      );
    } catch (e: any) {
      // Unique constraint violation on idempotencyKey — another concurrent
      // request already committed this order. Return the existing one (200).
      if (e?.code === '23505') {
        const existing = await this.getOrderByIdempotencyKey(idempotencyKey);
        if (existing) {
          await this.ensureJobForSourcingOrder(existing);
          return {
            ok: true,
            order: existing,
            deliveredCredential: existing.deliveredCredential ?? undefined,
          };
        }
      }
      // Lock acquisition failure or lock lost mid-flight
      if (
        e instanceof RedisUnavailableError ||
        e?.name === 'ExecutionError' ||
        e?.name === 'LockError' ||
        e?.name === 'ResourceLockedError'
      ) {
        // Lock lost AFTER the tx committed → return the committed order
        // instead of a misleading 409 (a blind retry with a new key would
        // double-charge the buyer).
        const committed = await this.getOrderByIdempotencyKey(idempotencyKey);
        if (committed) {
          await this.ensureJobForSourcingOrder(committed);
          return {
            ok: true,
            order: committed,
            deliveredCredential: committed.deliveredCredential ?? undefined,
          };
        }
        throw new ConflictException({
          errorCode: 'ORDER_LOCK_CONFLICT',
          message: 'Could not acquire checkout lock. Please try again.',
        });
      }
      throw e;
    }

    // Post-commit enqueue: the order row is committed before any worker can
    // see the job, so "job exists but order missing/non-SOURCING" can only
    // mean an enqueue-timeout ambiguity — the worker must discard those.
    // On enqueue failure, compensate: refund the debit and mark the order
    // REFUNDED, then surface 503 so the buyer can retry cleanly.
    if (sourcingJobData && sourcingRefundInfo) {
      try {
        await this.sourcingQueue.ensureSourcingJob(sourcingJobData);
      } catch (enqueueErr: any) {
        this.logger.error(
          `Sourcing enqueue failed for order ${sourcingRefundInfo.orderId}: ${enqueueErr?.message || String(enqueueErr)} — compensating with refund`,
        );
        try {
          const info = sourcingRefundInfo;
          await db.transaction(async (tx) => {
            await this.ledgerService.credit(
              info.walletId,
              info.amount,
              LedgerType.PURCHASE_REFUND,
              `${idempotencyKey}:refund`,
              info.orderId,
              tx,
            );
            await tx
              .update(orders)
              .set({ status: OrderStatus.REFUNDED })
              .where(eq(orders.id, info.orderId));
          });
        } catch (refundErr: any) {
          // Order stays SOURCING without a job — recovered by the
          // self-heal on idempotent replay and the 4.4 sweeper.
          this.logger.error(
            `Sourcing refund compensation failed for order ${sourcingRefundInfo.orderId}: ${refundErr?.message || String(refundErr)}`,
          );
        }
        throw new ServiceUnavailableException({
          errorCode: 'SOURCING_UNAVAILABLE',
          message: 'Sourcing queue is not available',
        });
      }

      // Payment taken + job queued — tell the buyer it is being processed
      // (fire-and-forget — never throws).
      if (productTitleForNotification) {
        void this.telegramBotService
          .sendSourcingNotice(
            telegramUser.id,
            result.order,
            productTitleForNotification,
          )
          .catch(() => {});
      }
    } else if (result.order.status === OrderStatus.SOURCING) {
      // Replay path (in-lock idempotency hit) — best-effort self-heal.
      await this.ensureJobForSourcingOrder(result.order);
    }

    // Post-commit: notify buyer via Telegram Bot (fire-and-forget — never throws)
    if (result.order.status === 'FULFILLED' && productTitleForNotification) {
      void this.telegramBotService
        .sendOrderConfirmation(
          telegramUser.id,
          result.order,
          productTitleForNotification,
        )
        .catch(() => {
          // Errors already logged inside sendOrderConfirmation — swallow here
        });
    }

    return result;
  }

  /**
   * Routing eligibility check — only called when in-house stock is empty and
   * the product declares EXTERNAL/HYBRID sourcing. Missing supplier row or
   * isActive=false means there is nowhere to route → caller throws
   * OUT_OF_STOCK.
   */
  private async isSupplierActive(
    supplierSourceId: string,
    tx: DbOrTx,
  ): Promise<boolean> {
    const [s] = await tx
      .select({ isActive: supplierSources.isActive })
      .from(supplierSources)
      .where(eq(supplierSources.id, supplierSourceId))
      .limit(1);
    return s?.isActive === true;
  }

  /**
   * Best-effort self-heal for replayed SOURCING orders: a missing or failed
   * sourcing job is re-driven (dedup `jobId` makes this a no-op when the job
   * is healthy). Never throws — a replay must always return the persisted
   * order even when the queue is down.
   */
  private async ensureJobForSourcingOrder(order: OrderDto): Promise<void> {
    if (order.status !== OrderStatus.SOURCING) return;
    try {
      const [p] = await db
        .select({ supplierSourceId: products.supplierSourceId })
        .from(products)
        .where(eq(products.id, order.productId))
        .limit(1);
      if (!p?.supplierSourceId) return;
      await this.sourcingQueue.ensureSourcingJob({
        orderId: order.id,
        productId: order.productId,
        supplierSourceId: p.supplierSourceId,
      });
    } catch (e: any) {
      this.logger.warn(
        `Self-heal enqueue failed for SOURCING order ${order.id}: ${e?.message || String(e)}`,
      );
    }
  }

  /**
   * List all orders for the current user, sorted by createdAt DESC.
   * Joins products to include productTitle.
   */
  async getMyOrders(telegramUser: TelegramUserDto): Promise<OrderDto[]> {
    const userRecord = await this.usersService.upsertByTelegram(telegramUser);

    const rows = await db
      .select({ order: orders, productTitle: products.title })
      .from(orders)
      .leftJoin(products, eq(orders.productId, products.id))
      .where(eq(orders.userId, userRecord.id))
      .orderBy(desc(orders.createdAt));

    return rows.map((r) => toOrderDto(r.order, r.productTitle ?? undefined));
  }

  async getOrderByIdempotencyKey(key: string): Promise<OrderDto | null> {
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.idempotencyKey, key))
      .limit(1);
    return order ? toOrderDto(order) : null;
  }
}
