import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { db, eq, sql, ledgerTransactions, wallets, type DbOrTx } from '@repo/database';
import { LedgerType } from '@repo/shared-types';
import type { LedgerTransactionDto } from '@repo/shared-types';
import { InsufficientFundsException } from '../../common/exceptions/insufficient-funds.exception';

export interface LedgerRecord extends Record<string, unknown> {
  id: string;
  walletId: string;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  referenceId: string | null;
  idempotencyKey: string | null;
  metadata: unknown | null;
  createdAt: Date;
}

@Injectable()
export class LedgerService {
  private toDto(record: LedgerRecord): LedgerTransactionDto {
    return {
      id: record.id,
      walletId: record.walletId,
      type: record.type as LedgerType,
      amount: String(record.amount),
      balanceBefore: String(record.balanceBefore),
      balanceAfter: String(record.balanceAfter),
      referenceId: record.referenceId ?? null,
      idempotencyKey: record.idempotencyKey ?? null,
      metadata: record.metadata ?? null,
      createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    };
  }

  private numericAdd(a: string, b: string): string {
    const [aInt, aDec = '0'] = a.split('.');
    const [bInt, bDec = '0'] = b.split('.');
    const scale = Math.max(aDec.length, bDec.length);
    const toBigInt = (int: string, dec: string) => BigInt(int + dec.padEnd(scale, '0'));
    const sum = toBigInt(aInt, aDec) + toBigInt(bInt, bDec);
    const sign = sum < 0n ? '-' : '';
    const abs = sign ? (-sum).toString() : sum.toString();
    if (scale === 0) return sign + abs;
    const padded = abs.padStart(scale + 1, '0');
    return sign + padded.slice(0, -scale) + '.' + padded.slice(-scale);
  }

  private numericCompare(a: string, b: string): number {
    const sum = this.numericAdd(a, '-' + b);
    if (sum.startsWith('-')) return -1;
    if (sum === '0' || sum === '0.00' || sum === '0.0' || sum === '0.') return 0;
    return 1;
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
    tx: DbOrTx = db,
  ): Promise<LedgerTransactionDto | null> {
    const [record] = await tx
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey))
      .limit(1);
    return record ? this.toDto(record as LedgerRecord) : null;
  }

  async credit(
    walletId: string,
    amount: string,
    type: LedgerType,
    idempotencyKey: string,
    referenceId?: string | null,
    metadata?: unknown | null,
    tx: DbOrTx = db,
  ): Promise<LedgerTransactionDto> {
    return this.recordTransaction(walletId, amount, type, idempotencyKey, referenceId ?? null, metadata ?? null, tx, true);
  }

  async debit(
    walletId: string,
    amount: string,
    type: LedgerType,
    idempotencyKey: string,
    referenceId?: string | null,
    metadata?: unknown | null,
    tx: DbOrTx = db,
  ): Promise<LedgerTransactionDto> {
    return this.recordTransaction(walletId, amount, type, idempotencyKey, referenceId ?? null, metadata ?? null, tx, false);
  }

  private async recordTransaction(
    walletId: string,
    amount: string,
    type: LedgerType,
    idempotencyKey: string,
    referenceId: string | null,
    metadata: unknown | null,
    tx: DbOrTx,
    isCredit: boolean,
  ): Promise<LedgerTransactionDto> {
    const existing = await this.getByIdempotencyKey(idempotencyKey, tx);
    if (existing) {
      return existing;
    }

    const runner = tx;
    const [wallet] = await runner
      .select()
      .from(wallets)
      .where(eq(wallets.id, walletId))
      .for('update');

    if (!wallet) {
      throw new InternalServerErrorException({
        errorCode: 'WALLET_NOT_FOUND',
        message: 'Wallet not found',
      });
    }

    const balanceBefore = String(wallet.balance);
    const signedAmount = isCredit ? amount : '-' + amount;
    const balanceAfter = this.numericAdd(balanceBefore, signedAmount);

    if (this.numericCompare(balanceAfter, '0') < 0) {
      throw new InsufficientFundsException();
    }

    const [updatedWallet] = await runner
      .update(wallets)
      .set({
        balance: balanceAfter,
        updatedAt: sql`now()`,
      })
      .where(eq(wallets.id, walletId))
      .returning();

    if (!updatedWallet) {
      throw new InternalServerErrorException({
        errorCode: 'WALLET_UPDATE_FAILED',
        message: 'Failed to update wallet balance',
      });
    }

    const [ledgerRecord] = await runner
      .insert(ledgerTransactions)
      .values({
        walletId,
        type,
        amount: isCredit ? amount : '-' + amount,
        balanceBefore,
        balanceAfter,
        referenceId,
        idempotencyKey,
        metadata,
      })
      .returning();

    if (!ledgerRecord) {
      throw new InternalServerErrorException({
        errorCode: 'LEDGER_INSERT_FAILED',
        message: 'Failed to insert ledger transaction',
      });
    }

    return this.toDto(ledgerRecord as LedgerRecord);
  }
}
