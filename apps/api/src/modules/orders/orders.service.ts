import {
  Injectable,
  NotFoundException,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  db,
  desc,
  eq,
  and,
  sql,
  orders,
  products,
  type DbOrTx,
} from '@repo/database';
import {
  OrderStatus,
  LedgerType,
  parseSignedDecimal,
  formatSignedDecimal,
  type OrderDto,
  type CheckoutResponseDto,
  type TelegramUserDto,
} from '@repo/shared-types';
import { RedisService, RedisUnavailableError } from '../../common/redis/redis.service';
import { LedgerService } from '../ledger/ledger.service';
import { InventoryService } from '../inventory/inventory.service';
import { WalletsService } from '../wallets/wallets.service';
import { UsersService } from '../users/users.service';
import { TelegramBotService } from '../../common/telegram/telegram-bot.service';
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
  constructor(
    private readonly redisService: RedisService,
    private readonly ledgerService: LedgerService,
    private readonly inventoryService: InventoryService,
    private readonly walletsService: WalletsService,
    private readonly usersService: UsersService,
    private readonly telegramBotService: TelegramBotService,
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

            // f. Reserve credential — null = out of stock
            const reserved = await this.inventoryService.reserveCredential(
              productId,
              order.id,
              tx,
            );
            if (!reserved) {
              throw new ConflictException({
                errorCode: 'OUT_OF_STOCK',
                message: `Product ${productId} is out of stock`,
              });
            }

            // g. Confirm sale — get plaintext credential
            const delivered = await this.inventoryService.confirmSold(
              reserved.id,
              order.id,
              tx,
            );

            // h. Update order → FULFILLED
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
        throw new ConflictException({
          errorCode: 'ORDER_LOCK_CONFLICT',
          message: 'Could not acquire checkout lock. Please try again.',
        });
      }
      throw e;
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
