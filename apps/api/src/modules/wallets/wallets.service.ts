import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { db, eq, wallets, sql, type DbOrTx } from '@repo/database';
import { LedgerType } from '@repo/shared-types';
import type { LedgerTransactionDto } from '@repo/shared-types';
import { LedgerService } from '../ledger/ledger.service';

type WalletRecord = typeof wallets.$inferSelect;

@Injectable()
export class WalletsService {
  constructor(private readonly ledgerService: LedgerService) {}

  async getOrCreateByUserId(userId: string, tx: DbOrTx = db): Promise<WalletRecord> {
    const [wallet] = await tx
      .insert(wallets)
      .values({
        userId,
        balance: '0.00',
        heldBalance: '0.00',
        currency: 'VND',
      })
      .onConflictDoUpdate({
        target: wallets.userId,
        set: {
          updatedAt: sql`now()`,
        },
      })
      .returning();

    if (!wallet) {
      throw new InternalServerErrorException({
        errorCode: 'WALLET_GET_OR_CREATE_FAILED',
        message: 'Failed to get or create wallet',
      });
    }

    return wallet;
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
    return this.ledgerService.credit(walletId, amount, type, idempotencyKey, referenceId, metadata, tx);
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
    return this.ledgerService.debit(walletId, amount, type, idempotencyKey, referenceId, metadata, tx);
  }
}
