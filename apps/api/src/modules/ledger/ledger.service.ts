import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
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

function parseSignedDecimal(value: string): bigint {
  const m = value.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Invalid decimal format: ${value}`);
  const [, sign, intPart, decPart = ''] = m;
  const dec = decPart.padEnd(2, '0');
  const units = BigInt(intPart + dec) * (sign === '-' ? -1n : 1n);
  return units;
}

function formatSignedDecimal(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const abs = sign ? (-units).toString() : units.toString();
  const padded = abs.padStart(3, '0');
  return `${sign}${padded.slice(0, -2)}.${padded.slice(-2)}`;
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

  private validateAmount(amount: string): void {
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      throw new InternalServerErrorException({
        errorCode: 'INVALID_LEDGER_AMOUNT',
        message: 'Amount must be a positive numeric string with up to 2 decimal places',
      });
    }
  }

  private numericAdd(a: string, b: string): string {
    return formatSignedDecimal(parseSignedDecimal(a) + parseSignedDecimal(b));
  }

  private numericCompare(a: string, b: string): number {
    const diff = parseSignedDecimal(a) - parseSignedDecimal(b);
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  }

  private async ensureTransaction<T>(fn: (tx: DbOrTx) => Promise<T>, runner: DbOrTx): Promise<T> {
    if (runner === db) {
      return (db as any).transaction(fn);
    }
    return fn(runner);
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
    tx: DbOrTx = db,
  ): Promise<LedgerTransactionDto> {
    return this.ensureTransaction(
      (runner) => this.recordTransaction(walletId, amount, type, idempotencyKey, referenceId ?? null, runner, true),
      tx,
    );
  }

  async debit(
    walletId: string,
    amount: string,
    type: LedgerType,
    idempotencyKey: string,
    referenceId?: string | null,
    tx: DbOrTx = db,
  ): Promise<LedgerTransactionDto> {
    return this.ensureTransaction(
      (runner) => this.recordTransaction(walletId, amount, type, idempotencyKey, referenceId ?? null, runner, false),
      tx,
    );
  }

  private async recordTransaction(
    walletId: string,
    amount: string,
    type: LedgerType,
    idempotencyKey: string,
    referenceId: string | null,
    runner: DbOrTx,
    isCredit: boolean,
  ): Promise<LedgerTransactionDto> {
    this.validateAmount(amount);

    const [wallet] = await runner
      .select()
      .from(wallets)
      .where(eq(wallets.id, walletId))
      .for('update');

    if (!wallet) {
      throw new NotFoundException({
        errorCode: 'WALLET_NOT_FOUND',
        message: 'Wallet not found',
      });
    }

    const existing = await runner
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey))
      .limit(1);

    if (existing.length > 0) {
      return this.toDto(existing[0] as LedgerRecord);
    }

    const balanceBefore = this.numericAdd(String(wallet.balance), '0');
    const signedAmount = isCredit ? this.numericAdd(amount, '0') : '-' + this.numericAdd(amount, '0');
    const balanceAfter = this.numericAdd(balanceBefore, signedAmount);

    if (this.numericCompare(balanceAfter, '0') < 0) {
      throw new InsufficientFundsException();
    }

    try {
      await runner
        .update(wallets)
        .set({
          balance: balanceAfter,
          updatedAt: sql`now()`,
        })
        .where(eq(wallets.id, walletId));

      const [ledgerRecord] = await runner
        .insert(ledgerTransactions)
        .values({
          walletId,
          type,
          amount: signedAmount,
          balanceBefore,
          balanceAfter,
          referenceId,
          idempotencyKey,
        })
        .returning();

      if (!ledgerRecord) {
        throw new InternalServerErrorException({
          errorCode: 'LEDGER_INSERT_FAILED',
          message: 'Failed to insert ledger transaction',
        });
      }

      return this.toDto(ledgerRecord as LedgerRecord);
    } catch (e: any) {
      if (e?.code === '23514' || (e?.message && e.message.includes('balance_non_negative'))) {
        throw new InsufficientFundsException();
      }
      if (e?.code === '23505') {
        const retried = await runner
          .select()
          .from(ledgerTransactions)
          .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey))
          .limit(1);
        if (retried.length > 0) {
          return this.toDto(retried[0] as LedgerRecord);
        }
      }
      throw e;
    }
  }
}
