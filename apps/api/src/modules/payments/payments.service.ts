import { Injectable, BadRequestException, ServiceUnavailableException, InternalServerErrorException } from '@nestjs/common';
import { db, eq, paymentTransactions, sql, type DbOrTx } from '@repo/database';
import { PaymentStatus, PaymentGateway, type PaymentTransactionDto, type TelegramUserDto } from '@repo/shared-types';
import { VietQRService } from './vietqr.service';
import { UserWalletService } from '../users/user-wallet.service';

const MIN_TOPUP_AMOUNT = 10000;
const DEFAULT_TIMEOUT_MIN = 30;
const MAX_TRANSFER_CONTENT_RETRIES = 3;

export type PaymentRecord = typeof paymentTransactions.$inferSelect;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly vietQRService: VietQRService,
    private readonly userWalletService: UserWalletService,
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
