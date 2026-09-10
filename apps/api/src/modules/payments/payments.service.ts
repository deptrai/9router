import { Injectable, BadRequestException, ServiceUnavailableException, InternalServerErrorException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { db, eq, paymentTransactions, sql, type DbOrTx } from '@repo/database';
import { PaymentStatus, PaymentGateway, LedgerType, type PaymentTransactionDto, type TelegramUserDto, type VietQRWebhookDto, type VietQRWebhookResponseDto } from '@repo/shared-types';
import { VietQRService } from './vietqr.service';
import { UserWalletService } from '../users/user-wallet.service';
import { WalletsService } from '../wallets/wallets.service';
import { LedgerService } from '../ledger/ledger.service';

const MIN_TOPUP_AMOUNT = 10000;
const DEFAULT_TIMEOUT_MIN = 30;
const MAX_TRANSFER_CONTENT_RETRIES = 3;



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

export type PaymentRecord = typeof paymentTransactions.$inferSelect;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly vietQRService: VietQRService,
    private readonly userWalletService: UserWalletService,
    private readonly walletsService: WalletsService,
    private readonly ledgerService: LedgerService,
  ) {}

  async createVietQrPayment(
    dto: TelegramUserDto,
    amount: number,
    outerTx?: DbOrTx,
  ): Promise<PaymentTransactionDto> {
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < MIN_TOPUP_AMOUNT) {
      throw new BadRequestException({
        errorCode: 'INVALID_TOPUP_AMOUNT',
        message: `Top-up amount must be an integer greater than or equal to ${MIN_TOPUP_AMOUNT} VND`,
      });
    }

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

    // Reuse an existing pending payment for the same wallet and amount if not expired
    const [existing] = await runner
      .select()
      .from(paymentTransactions)
      .where(
        sql`${paymentTransactions.walletId} = ${wallet.id} AND ${paymentTransactions.amount} = ${this.toNumeric(amount)} AND ${paymentTransactions.status} = ${PaymentStatus.PENDING} AND ${paymentTransactions.expiresAt} > now()`,
      )
      .limit(1);

    if (existing) {
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

  async processVietQRWebhook(
    dto: VietQRWebhookDto,
    outerTx?: DbOrTx,
  ): Promise<ProcessVietQRWebhookResult> {
    if (!dto || typeof dto !== 'object') {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_PAYLOAD' };
    }

    const transactionId = dto.transactionId?.trim();
    if (!transactionId) {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_PAYLOAD' };
    }

    if (!Number.isFinite(dto.amount) || !Number.isInteger(dto.amount) || dto.amount < 10000) {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_AMOUNT' };
    }

    const runner = outerTx ?? db;

    const startMs = Date.now();

    // Idempotency: check if this external transaction was already processed
    const [alreadyProcessed] = await runner
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.externalTransactionId, transactionId))
      .limit(1);

    if (alreadyProcessed) {
      return { ok: true, matched: true, alreadyProcessed: true };
    }

    const content = dto.content?.trim();
    if (!content) {
      return { ok: false, matched: false, reason: 'WEBHOOK_INVALID_PAYLOAD' };
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

    const idempotencyKey = `payment:vietqr:${transactionId}`;

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

      await runner
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
        .where(eq(paymentTransactions.id, payment.id));

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
