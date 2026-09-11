import { Injectable, BadRequestException, ServiceUnavailableException, InternalServerErrorException, Logger } from '@nestjs/common';
import { RedisService, RedisUnavailableError } from '../../common/redis/redis.service';
import { ExecutionError, ResourceLockedError } from 'redlock';
import * as crypto from 'node:crypto';
import { db, eq, paymentTransactions, sql, type DbOrTx } from '@repo/database';
import { PaymentStatus, PaymentGateway, LedgerType, type PaymentTransactionDto, type TelegramUserDto, type VietQRWebhookDto, type VietQRWebhookResponseDto, type BitcartWebhookDto, type BitcartWebhookResponseDto } from '@repo/shared-types';
import { VietQRService } from './vietqr.service';
import { BitcartService } from './bitcart.service';
import { UserWalletService } from '../users/user-wallet.service';
import { WalletsService } from '../wallets/wallets.service';
import { LedgerService } from '../ledger/ledger.service';

const MIN_TOPUP_AMOUNT = 10000;
const DEFAULT_MAX_TOPUP_VND = 50_000_000;
const DEFAULT_TIMEOUT_MIN = 30;
const MAX_TRANSFER_CONTENT_RETRIES = 3;

function getMaxTopupVnd(): number {
  const raw = Number(process.env.MAX_TOPUP_VND);
  return Number.isFinite(raw) && raw >= MIN_TOPUP_AMOUNT ? Math.floor(raw) : DEFAULT_MAX_TOPUP_VND;
}



export interface ProcessVietQRWebhookResult {
  ok: boolean;
  matched: boolean;
  credited?: boolean;
  paymentId?: string;
  walletId?: string;
  balanceAfter?: string;
  reason?: string;
  currentStatus?: string;
  alreadyProcessed?: boolean;
}

export interface ProcessBitcartWebhookResult {
  ok: boolean;
  matched: boolean;
  credited?: boolean;
  paymentId?: string;
  walletId?: string;
  balanceAfter?: string;
  reason?: string;
  currentStatus?: string;
  alreadyProcessed?: boolean;
}

export type PaymentRecord = typeof paymentTransactions.$inferSelect;

const PAYMENT_LOCK_TTL_MS = 5000;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly vietQRService: VietQRService,
    private readonly bitcartService: BitcartService,
    private readonly userWalletService: UserWalletService,
    private readonly walletsService: WalletsService,
    private readonly ledgerService: LedgerService,
    private readonly redisService: RedisService,
  ) {}

  async createVietQrPayment(
    dto: TelegramUserDto,
    amount: number,
    outerTx?: DbOrTx,
  ): Promise<PaymentTransactionDto> {
    this.validateTopupAmount(amount);

    const bankBin = process.env.VND_BANK_BIN?.trim() ?? '';
    const accountNo = process.env.VND_BANK_ACCOUNT?.trim() ?? '';
    const bankName = process.env.VND_BANK_NAME?.trim() ?? '';

    if (!this.vietQRService.isConfigured(bankBin, accountNo)) {
      throw new ServiceUnavailableException({
        errorCode: 'VIETQR_NOT_CONFIGURED',
        message: 'VietQR bank account is not configured',
      });
    }

    const runner = outerTx ?? db;

    const { user, wallet } = await this.userWalletService.upsertUserAndWallet(dto, runner);

    // Reuse an existing pending payment for the same wallet, gateway and amount if not expired
    const [existing] = await runner
      .select()
      .from(paymentTransactions)
      .where(
        sql`${paymentTransactions.walletId} = ${wallet.id} AND ${paymentTransactions.gateway} = ${PaymentGateway.VIETQR} AND ${paymentTransactions.amount} = ${this.toNumeric(amount)} AND ${paymentTransactions.status} = ${PaymentStatus.PENDING} AND ${paymentTransactions.expiresAt} > now()`,
      )
      .limit(1);

    if (existing && (existing as any).gateway === PaymentGateway.VIETQR) {
      return this.toDto(existing as PaymentRecord, bankBin, accountNo);
    }

    const timeoutMin = Number.isFinite(Number(process.env.VND_PAYMENT_TIMEOUT_MIN))
      ? Number(process.env.VND_PAYMENT_TIMEOUT_MIN)
      : DEFAULT_TIMEOUT_MIN;
    const expiresAt = new Date(Date.now() + timeoutMin * 60 * 1000);
    const transferContent = await this.generateUniqueTransferContent(runner);

    const qrPayload = this.vietQRService.generateVietQRPayload({
      bankBin,
      accountNo,
      amount,
      transferContent,
    });

    const [record] = await runner
      .insert(paymentTransactions)
      .values({
        walletId: wallet.id,
        gateway: PaymentGateway.VIETQR,
        amount: this.toNumeric(amount),
        status: PaymentStatus.PENDING,
        transferContent,
        bankName,
        bankBin,
        bankAccount: accountNo,
        qrPayload,
        expiresAt,
      })
      .returning();

    if (!record) {
      throw new InternalServerErrorException({
        errorCode: 'PAYMENT_CREATE_FAILED',
        message: 'Failed to create VietQR payment request',
      });
    }

    return this.toDto(record as PaymentRecord, bankBin, accountNo);
  }

  private async generateUniqueTransferContent(runner: DbOrTx, retries = 0): Promise<string> {
    const transferContent = this.vietQRService.generateTransferContent();

    const [existing] = await runner
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transferContent, transferContent))
      .limit(1);

    if (existing) {
      if (retries >= MAX_TRANSFER_CONTENT_RETRIES) {
        throw new InternalServerErrorException({
          errorCode: 'PAYMENT_TRANSFER_CONTENT_CONFLICT',
          message: 'Unable to generate a unique VietQR transfer content',
        });
      }
      return this.generateUniqueTransferContent(runner, retries + 1);
    }

    return transferContent;
  }

  private toNumeric(amount: number): string {
    return Math.floor(amount).toFixed(2);
  }

  private generateBitcartTransferContent(): string {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `9R_CRYPTO_${suffix}`;
  }

  private async generateUniqueBitcartTransferContent(runner: DbOrTx, retries = 0): Promise<string> {
    const transferContent = this.generateBitcartTransferContent();

    const [existing] = await runner
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transferContent, transferContent))
      .limit(1);

    if (existing) {
      if (retries >= MAX_TRANSFER_CONTENT_RETRIES) {
        throw new InternalServerErrorException({
          errorCode: 'PAYMENT_TRANSFER_CONTENT_CONFLICT',
          message: 'Unable to generate a unique Bitcart transfer content',
        });
      }
      return this.generateUniqueBitcartTransferContent(runner, retries + 1);
    }

    return transferContent;
  }

  private convertVndToUsd(vndAmount: number): number {
    const rate = Number(process.env.VND_USD_RATE);
    if (Number.isFinite(rate) && rate > 0) {
      return Math.ceil((vndAmount / rate) * 100 - 1e-9) / 100;
    }
    // Default fallback rate 1 USD = 25,000 VND
    return Math.ceil((vndAmount / 25000) * 100 - 1e-9) / 100;
  }

  private validateTopupAmount(amount: number): void {
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < MIN_TOPUP_AMOUNT) {
      throw new BadRequestException({
        errorCode: 'INVALID_TOPUP_AMOUNT',
        message: `Top-up amount must be an integer greater than or equal to ${MIN_TOPUP_AMOUNT} VND`,
      });
    }
    const max = getMaxTopupVnd();
    if (amount > max) {
      throw new BadRequestException({
        errorCode: 'INVALID_TOPUP_AMOUNT',
        message: `Top-up amount must not exceed ${max} VND`,
      });
    }
  }

  async createBitcartPayment(
    dto: TelegramUserDto,
    amount: number,
    coin: string,
    network: string,
    outerTx?: DbOrTx,
  ): Promise<PaymentTransactionDto> {
    this.validateTopupAmount(amount);

    let config;
    try {
      config = this.bitcartService.getConfig();
    } catch {
      config = null;
    }

    if (!config) {
      throw new ServiceUnavailableException({
        errorCode: 'BITCART_NOT_CONFIGURED',
        message: 'Bitcart is not configured',
      });
    }

    // Validate coin/network support early
    try {
      this.bitcartService.validateCoinNetwork(coin, network);
    } catch (err: any) {
      if (err.message?.includes('network:') || err.message?.includes('support')) {
        throw new BadRequestException({
          errorCode: 'UNSUPPORTED_COIN_NETWORK',
          message: err.message,
        });
      }
      throw err;
    }

    const runner = outerTx ?? db;
    const { wallet } = await this.userWalletService.upsertUserAndWallet(dto, runner);

    // Reuse an existing pending payment for the same wallet, gateway, amount, coin, and network if not expired
    const [existing] = await runner
      .select()
      .from(paymentTransactions)
      .where(
        sql`${paymentTransactions.walletId} = ${wallet.id} AND ${paymentTransactions.gateway} = ${PaymentGateway.BITCART} AND ${paymentTransactions.amount} = ${this.toNumeric(amount)} AND ${paymentTransactions.status} = ${PaymentStatus.PENDING} AND ${paymentTransactions.expiresAt} > now() AND ${paymentTransactions.metadata}->>'coin' = ${coin} AND ${paymentTransactions.metadata}->>'network' = ${network}`,
      )
      .limit(1);

    if (
      existing &&
      (existing as any).gateway === PaymentGateway.BITCART &&
      (existing as any).metadata?.coin === coin &&
      (existing as any).metadata?.network === network
    ) {
      return this.toBitcartDto(existing as PaymentRecord);
    }

    const timeoutMin = Number.isFinite(Number(process.env.BITCART_PAYMENT_TIMEOUT_MIN))
      ? Number(process.env.BITCART_PAYMENT_TIMEOUT_MIN)
      : DEFAULT_TIMEOUT_MIN;
    const expiresAt = new Date(Date.now() + timeoutMin * 60 * 1000);
    const transferContent = await this.generateUniqueBitcartTransferContent(runner);

    const bitcartAmount = this.convertVndToUsd(amount);
    const bitcartCurrency = (process.env.BITCART_CURRENCY?.trim() || 'USD').toUpperCase();
    const invoiceAmount = bitcartCurrency === 'VND' ? amount : bitcartAmount;

    let invoice: any;
    try {
      invoice = await this.bitcartService.createInvoice({
        amount: invoiceAmount,
        currency: bitcartCurrency,
        coin,
        network,
        orderId: transferContent,
      });
    } catch (err: any) {
      throw new ServiceUnavailableException({
        errorCode: 'BITCART_API_ERROR',
        message: err.message || 'Failed to create Bitcart invoice',
      });
    }

    const [record] = await runner
      .insert(paymentTransactions)
      .values({
        walletId: wallet.id,
        gateway: PaymentGateway.BITCART,
        amount: this.toNumeric(amount),
        status: PaymentStatus.PENDING,
        transferContent,
        externalTransactionId: invoice.gatewayId,
        expiresAt,
        metadata: {
          bitcartInvoiceId: invoice.gatewayId,
          payAddress: invoice.payAddress,
          cryptoAmount: invoice.cryptoAmount,
          cryptoCurrency: invoice.cryptoCurrency,
          network,
          coin,
          paymentUrl: invoice.paymentUrl,
          bitcartExpiresAt: invoice.expiresAt,
          bitcartCurrency,
          bitcartPrice: invoiceAmount,
        },
      })
      .returning();

    if (!record) {
      throw new InternalServerErrorException({
        errorCode: 'PAYMENT_CREATE_FAILED',
        message: 'Failed to create Bitcart payment request',
      });
    }

    return this.toBitcartDto(record as PaymentRecord);
  }

  async processBitcartWebhook(
    dto: BitcartWebhookDto,
  ): Promise<ProcessBitcartWebhookResult> {
    if (!dto || typeof dto !== "object") {
      return { ok: false, matched: false, reason: "WEBHOOK_INVALID_PAYLOAD" };
    }

    const invoiceId = typeof dto.id === "string" ? dto.id.trim() : "";
    if (!invoiceId) {
      return { ok: false, matched: false, reason: "WEBHOOK_INVALID_PAYLOAD" };
    }

    const rawStatus = typeof dto.status === "string" ? dto.status.toLowerCase() : "";
    if (!this.bitcartService.parseStatus(rawStatus)) {
      return { ok: false, matched: false, reason: "WEBHOOK_INVALID_PAYLOAD" };
    }

    const lockKey = `lock:payment:bitcart:${invoiceId}`;
    let routineExecuted = false;
    const lockWaitStart = Date.now();
    try {
      return await this.redisService.withLock(
        lockKey,
        PAYMENT_LOCK_TTL_MS,
        (signal) => {
          routineExecuted = true;
          this.logger.log({
            event: "payment_lock_acquired",
            externalTransactionId: invoiceId,
            gateway: "bitcart",
            lockWaitMs: Date.now() - lockWaitStart,
          });
          return db.transaction((tx) => this.processBitcartWebhookCore(dto, tx, signal));
        },
      );
    } catch (err: unknown) {
      if (routineExecuted) {
        throw err;
      }
      if (await this.isResourceLocked(err)) {
        this.logger.warn({
          event: "payment_lock_contention",
          externalTransactionId: invoiceId,
          gateway: "bitcart",
        });
        return { ok: true, matched: true, alreadyProcessed: true };
      }

      this.logger.warn({
        event: "redis_unavailable",
        externalTransactionId: invoiceId,
        message: (err as any)?.message,
      });

      return db.transaction((tx) => this.processBitcartWebhookCore(dto, tx));
    }
  }

  async processBitcartWebhookCore(
    dto: BitcartWebhookDto,
    runner: DbOrTx,
    signal?: { aborted: boolean; error?: Error },
  ): Promise<ProcessBitcartWebhookResult> {
    const startMs = Date.now();

    if (!dto || typeof dto !== 'object') {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_PAYLOAD' };
    }

    const invoiceId = typeof dto.id === 'string' ? dto.id.trim() : '';
    if (!invoiceId) {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_PAYLOAD' };
    }

    const rawStatus = typeof dto.status === 'string' ? dto.status.toLowerCase() : '';
    const mappedStatus = this.bitcartService.parseStatus(rawStatus);
    if (!mappedStatus) {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_PAYLOAD' };
    }

    // Match the pending payment transaction for this Bitcart invoice
    const matching = await runner
      .select()
      .from(paymentTransactions)
      .where(sql`${paymentTransactions.externalTransactionId} = ${invoiceId} AND ${paymentTransactions.status} = ${PaymentStatus.PENDING}`)
      .limit(1);

    if (matching.length === 0) {
      // Idempotency check: verify if this external transaction was already completed
      const [alreadyCompleted] = await runner
        .select()
        .from(paymentTransactions)
        .where(sql`${paymentTransactions.externalTransactionId} = ${invoiceId} AND ${paymentTransactions.status} = ${PaymentStatus.COMPLETED}`)
        .limit(1);

      if (alreadyCompleted) {
        return { ok: true, matched: true, alreadyProcessed: true };
      }

      return { ok: true, matched: false, reason: 'NO_MATCHING_PAYMENT' };
    }

    const payment = matching[0] as PaymentRecord;

    if (mappedStatus !== 'settled') {
      const terminalStatuses = ['expired', 'failed', 'refunded'];
      if (terminalStatuses.includes(mappedStatus)) {
        const nextStatus = mappedStatus === 'expired' ? PaymentStatus.EXPIRED : PaymentStatus.FAILED;
        await runner
          .update(paymentTransactions)
          .set({ status: nextStatus, updatedAt: new Date() })
          .where(sql`${paymentTransactions.id} = ${payment.id}`);
      }
      return {
        ok: true,
        matched: true,
        credited: false,
        paymentId: payment.id,
        reason: 'STATUS_NOT_SETTLED',
        currentStatus: mappedStatus,
      };
    }

    const payments = Array.isArray(dto.payments) ? dto.payments : [];
    const amountReceived = payments.reduce((sum, p) => {
      const n = Number(p?.amount);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);

    if (amountReceived <= 0) {
      return {
        ok: true,
        matched: true,
        credited: false,
        paymentId: payment.id,
        reason: 'INVALID_SETTLEMENT_AMOUNT',
      };
    }

    const expectedCrypto = typeof payment.metadata === 'object' && payment.metadata !== null
      ? Number((payment.metadata as any)?.cryptoAmount)
      : NaN;
    if (Number.isFinite(expectedCrypto) && Math.abs(amountReceived - expectedCrypto) > 1e-8) {
      return {
        ok: true,
        matched: true,
        credited: false,
        paymentId: payment.id,
        reason: 'AMOUNT_MISMATCH',
      };
    }

    const txHash =
      payments.find((p) => p?.lookup_field || p?.tx_hash)?.lookup_field ||
      payments.find((p) => p?.lookup_field || p?.tx_hash)?.tx_hash ||
      null;
    const confirmations = Math.max(0, ...payments.map((p) => Number(p?.confirmations) || 0));

    // Bitcart `complete` is the terminal settlement state. We credit the wallet even if the
    // payment_transactions.expiresAt has passed, because on-chain confirmation can arrive late.
    // Expiry only blocks creation of new invoices, not crediting of a legitimately settled one.
    const idempotencyKey = `payment:bitcart:${invoiceId}`;

    if (signal?.aborted) {
      throw signal.error ?? new RedisUnavailableError('Lock lost before Bitcart credit');
    }

    try {
      const ledger = await this.walletsService.credit(
        payment.walletId,
        payment.amount,
        LedgerType.TOPUP_CRYPTO,
        idempotencyKey,
        payment.id,
        runner,
      );

      const metadata = typeof payment.metadata === 'object' && payment.metadata !== null
        ? { ...payment.metadata }
        : {};

      const updated = await runner
        .update(paymentTransactions)
        .set({
          status: PaymentStatus.COMPLETED,
          metadata: {
            ...metadata,
            webhookReceivedAt: new Date().toISOString(),
            webhookPayloadHash: this.computeBitcartPayloadHash(dto),
            bitcartStatus: rawStatus,
            confirmations,
            txHash,
          },
        })
        .where(sql`${paymentTransactions.id} = ${payment.id} AND ${paymentTransactions.status} = ${PaymentStatus.PENDING}`)
        .returning();

      if (updated.length === 0) {
        return { ok: true, matched: true, alreadyProcessed: true };
      }

      const processingTimeMs = Date.now() - startMs;
      console.log(JSON.stringify({
        event: 'bitcart_webhook',
        invoiceId,
        status: rawStatus,
        matched: true,
        credited: true,
        amount: amountReceived,
        walletId: payment.walletId,
        processingTimeMs,
      }));

      return {
        ok: true,
        matched: true,
        credited: true,
        paymentId: payment.id,
        walletId: payment.walletId,
        balanceAfter: ledger.balanceAfter,
      };
    } catch (e: any) {
      const processingTimeMs = Date.now() - startMs;
      console.error(JSON.stringify({
        event: 'bitcart_webhook',
        invoiceId,
        status: rawStatus,
        matched: true,
        credited: false,
        amount: amountReceived,
        walletId: payment.walletId,
        processingTimeMs,
        error: e?.message,
      }));

      if (e?.code === '23505' || e?.message?.includes('unique constraint') || e?.message?.includes('idempotency')) {
        return { ok: true, matched: true, alreadyProcessed: true };
      }

      throw new InternalServerErrorException({
        errorCode: 'WEBHOOK_PROCESSING_FAILED',
        message: 'Failed to process Bitcart webhook',
      });
    }
  }

  private async isResourceLocked(err: unknown): Promise<boolean> {
    if (!err) return false;
    if (err instanceof ResourceLockedError || (err as any)?.name === "ResourceLockedError") {
      return true;
    }
    if (err instanceof ExecutionError || (err as any)?.name === "ExecutionError") {
      const attempts = (err as ExecutionError).attempts;
      if (Array.isArray(attempts) && attempts.length > 0) {
        let sawLockVote = false;
        for (const attemptPromise of attempts) {
          try {
            const stats = await Promise.resolve(attemptPromise);
            if (stats?.votesAgainst instanceof Map && stats.votesAgainst.size > 0) {
              // Treat as a genuine lock conflict only when EVERY vote-against in the
              // attempt is a ResourceLockedError. A mix of lock votes and network
              // errors means Redis/quorum trouble, not a concurrent lock holder.
              for (const clientErr of stats.votesAgainst.values()) {
                const isLock =
                  clientErr instanceof ResourceLockedError ||
                  clientErr?.name === "ResourceLockedError" ||
                  clientErr?.message?.includes("requested resources");
                if (!isLock) {
                  return false; // network/client failure → fail-open, not "already processed"
                }
                sawLockVote = true;
              }
            }
          } catch {
            // ignore
          }
        }
        return sawLockVote;
      }
      return false;
    }
    const msg = (err as any)?.message ?? "";
    return msg.includes("The operation was applied to: 0 of the 1 requested resources");
  }

  private computeBitcartPayloadHash(dto: BitcartWebhookDto): string {
    const raw = JSON.stringify(dto);
    return crypto.createHmac('sha256', process.env.BITCART_WEBHOOK_SECRET ?? '').update(raw).digest('hex');
  }

  private toBitcartDto(record: PaymentRecord): PaymentTransactionDto {
    const metadata = record.metadata as any;
    return {
      id: record.id,
      walletId: record.walletId,
      gateway: record.gateway as PaymentGateway,
      externalTransactionId: record.externalTransactionId ?? null,
      amount: String(record.amount),
      status: record.status as PaymentStatus,
      transferContent: record.transferContent,
      bankName: record.bankName ?? null,
      bankBin: record.bankBin ?? null,
      bankAccount: record.bankAccount ?? null,
      qrPayload: record.qrPayload ?? null,
      qrImageUrl: null,
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
      metadata: {
        ...metadata,
        bitcartInvoiceId: metadata?.bitcartInvoiceId ?? record.externalTransactionId,
        payAddress: metadata?.payAddress ?? null,
        cryptoAmount: metadata?.cryptoAmount ?? null,
        cryptoCurrency: metadata?.cryptoCurrency ?? null,
        network: metadata?.network ?? null,
        paymentUrl: metadata?.paymentUrl ?? null,
      },
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async processVietQRWebhook(
    dto: VietQRWebhookDto,
  ): Promise<ProcessVietQRWebhookResult> {
    if (!dto || typeof dto !== "object") {
      return { ok: false, matched: false, reason: "WEBHOOK_INVALID_PAYLOAD" };
    }

    const transactionId = typeof dto.transactionId === "string" ? dto.transactionId.trim() : "";
    if (!transactionId) {
      return { ok: false, matched: false, reason: "WEBHOOK_INVALID_PAYLOAD" };
    }

    const content = typeof dto.content === "string" ? dto.content.trim() : "";
    if (!content) {
      return { ok: false, matched: false, reason: "WEBHOOK_INVALID_PAYLOAD" };
    }

    if (dto.timestamp !== undefined && (typeof dto.timestamp !== "string" || Number.isNaN(Date.parse(dto.timestamp)))) {
      return { ok: false, matched: false, reason: "WEBHOOK_INVALID_PAYLOAD" };
    }

    if (!Number.isFinite(dto.amount) || !Number.isInteger(dto.amount) || dto.amount < 10000) {
      return { ok: false, matched: false, reason: "WEBHOOK_INVALID_AMOUNT" };
    }

    const lockKey = `lock:payment:vietqr:${transactionId}`;
    let routineExecuted = false;
    const lockWaitStart = Date.now();
    try {
      return await this.redisService.withLock(
        lockKey,
        PAYMENT_LOCK_TTL_MS,
        (signal) => {
          routineExecuted = true;
          this.logger.log({
            event: "payment_lock_acquired",
            externalTransactionId: transactionId,
            gateway: "vietqr",
            lockWaitMs: Date.now() - lockWaitStart,
          });
          return db.transaction((tx) => this.processVietQRWebhookCore(dto, tx, signal));
        },
      );
    } catch (err: unknown) {
      if (routineExecuted) {
        throw err;
      }
      if (await this.isResourceLocked(err)) {
        this.logger.warn({
          event: "payment_lock_contention",
          externalTransactionId: transactionId,
          gateway: "vietqr",
        });
        return { ok: true, matched: true, alreadyProcessed: true };
      }

      this.logger.warn({
        event: "redis_unavailable",
        externalTransactionId: transactionId,
        message: (err as any)?.message,
      });

      return db.transaction((tx) => this.processVietQRWebhookCore(dto, tx));
    }
  }

  async processVietQRWebhookCore(
    dto: VietQRWebhookDto,
    runner: DbOrTx,
    signal?: { aborted: boolean; error?: Error },
  ): Promise<ProcessVietQRWebhookResult> {
    const startMs = Date.now();

    if (!dto || typeof dto !== 'object') {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_PAYLOAD' };
    }

    const transactionId = typeof dto.transactionId === 'string' ? dto.transactionId.trim() : '';
    if (!transactionId) {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_PAYLOAD' };
    }

    const content = typeof dto.content === 'string' ? dto.content.trim() : '';
    if (!content) {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_PAYLOAD' };
    }

    if (dto.timestamp !== undefined && (typeof dto.timestamp !== 'string' || Number.isNaN(Date.parse(dto.timestamp)))) {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_PAYLOAD' };
    }

    if (!Number.isFinite(dto.amount) || !Number.isInteger(dto.amount) || dto.amount < 10000) {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_AMOUNT' };
    }

    // Idempotency: check if this external transaction was already processed
    const [alreadyProcessed] = await runner
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.externalTransactionId, transactionId))
      .limit(1);

    if (alreadyProcessed) {
      return { ok: true, matched: true, alreadyProcessed: true };
    }

    const matching = await runner
      .select()
      .from(paymentTransactions)
      .where(sql`${paymentTransactions.transferContent} = ${content} AND ${paymentTransactions.status} = ${PaymentStatus.PENDING}`)
      .limit(2);

    if (matching.length === 0) {
      return { ok: true, matched: false, reason: 'NO_MATCHING_PAYMENT' };
    }

    if (matching.length > 1) {
      throw new InternalServerErrorException({
        errorCode: 'PAYMENT_AMBIGUOUS_MATCH',
        message: 'Multiple pending payments matched the same transfer content',
      });
    }

    const payment = matching[0] as PaymentRecord;
    const paymentAmount = Number(payment.amount);
    if (paymentAmount !== dto.amount) {
      return {
        ok: true,
        matched: true,
        credited: false,
        paymentId: payment.id,
        reason: 'AMOUNT_MISMATCH',
      };
    }

    if (payment.status !== PaymentStatus.PENDING) {
      return {
        ok: true,
        matched: true,
        credited: false,
        paymentId: payment.id,
        reason: 'ALREADY_PROCESSED',
        currentStatus: payment.status,
      };
    }

    if (payment.expiresAt && payment.expiresAt.getTime() <= Date.now()) {
      return {
        ok: true,
        matched: true,
        credited: false,
        paymentId: payment.id,
        reason: 'PAYMENT_EXPIRED',
      };
    }

    const idempotencyKey = `payment:vietqr:${transactionId}`;

    if (signal?.aborted) {
      throw signal.error ?? new RedisUnavailableError('Lock lost before VietQR credit');
    }

    try {
      const ledger = await this.walletsService.credit(
        payment.walletId,
        payment.amount,
        LedgerType.TOPUP_VIETQR,
        idempotencyKey,
        payment.id,
        runner,
      );

      const metadata = typeof payment.metadata === 'object' && payment.metadata !== null
        ? { ...payment.metadata }
        : {};

      const updated = await runner
        .update(paymentTransactions)
        .set({
          status: PaymentStatus.COMPLETED,
          externalTransactionId: transactionId,
          metadata: {
            ...metadata,
            webhookReceivedAt: new Date().toISOString(),
            webhookPayloadHash: this.computePayloadHash(dto),
          },
        })
        .where(sql`${paymentTransactions.id} = ${payment.id} AND ${paymentTransactions.status} = ${PaymentStatus.PENDING}`)
        .returning();

      if (updated.length === 0) {
        return { ok: true, matched: true, alreadyProcessed: true };
      }

      const processingTimeMs = Date.now() - startMs;
      console.log(JSON.stringify({
        event: 'vietqr_webhook',
        transactionId,
        matched: true,
        credited: true,
        amount: dto.amount,
        walletId: payment.walletId,
        processingTimeMs,
      }));

      return {
        ok: true,
        matched: true,
        credited: true,
        paymentId: payment.id,
        walletId: payment.walletId,
        balanceAfter: ledger.balanceAfter,
      };
    } catch (e: any) {
      const processingTimeMs = Date.now() - startMs;
      console.error(JSON.stringify({
        event: 'vietqr_webhook',
        transactionId,
        matched: true,
        credited: false,
        amount: dto.amount,
        walletId: payment.walletId,
        processingTimeMs,
        error: e?.message,
      }));

      if (e?.code === '23505' || e?.message?.includes('unique constraint') || e?.message?.includes('idempotency')) {
        return { ok: true, matched: true, alreadyProcessed: true };
      }

      throw new InternalServerErrorException({
        errorCode: 'WEBHOOK_PROCESSING_FAILED',
        message: 'Failed to process VietQR webhook',
      });
    }
  }

  private computePayloadHash(dto: VietQRWebhookDto): string {
    const raw = JSON.stringify(dto);
    return crypto.createHmac('sha256', process.env.VIETQR_WEBHOOK_SECRET ?? '').update(raw).digest('hex');
  }

  private toDto(record: PaymentRecord, bankBin: string, accountNo: string): PaymentTransactionDto {
    return {
      id: record.id,
      walletId: record.walletId,
      gateway: record.gateway as PaymentGateway,
      externalTransactionId: record.externalTransactionId ?? null,
      amount: String(record.amount),
      status: record.status as PaymentStatus,
      transferContent: record.transferContent,
      bankName: record.bankName ?? null,
      bankBin: record.bankBin ?? null,
      bankAccount: record.bankAccount ?? null,
      qrPayload: record.qrPayload ?? null,
      qrImageUrl: this.vietQRService.generateVietQRUrl({
        bankBin: record.bankBin ?? bankBin,
        accountNo: record.bankAccount ?? accountNo,
        amount: Number(record.amount),
        transferContent: record.transferContent,
      }),
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
      metadata: record.metadata ?? null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
