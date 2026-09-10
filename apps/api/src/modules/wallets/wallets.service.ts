import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { db, eq, wallets, sql, type DbOrTx } from '@repo/database';

type WalletRecord = typeof wallets.$inferSelect;

@Injectable()
export class WalletsService {
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
}
