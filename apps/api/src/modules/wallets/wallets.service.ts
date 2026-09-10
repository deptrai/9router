import { Injectable } from '@nestjs/common';
import { db, eq, wallets, type DbOrTx } from '@repo/database';

@Injectable()
export class WalletsService {
  async getOrCreateByUserId(userId: string, tx: DbOrTx = db): Promise<string> {
    const existing = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      return existing[0].id;
    }

    const [created] = await tx
      .insert(wallets)
      .values({
        userId,
        balance: '0.00',
        heldBalance: '0.00',
        currency: 'VND',
      })
      .onConflictDoNothing({ target: wallets.userId })
      .returning();

    if (created) {
      return created.id;
    }

    // Race condition: another transaction inserted the wallet
    const fallback = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, userId))
      .limit(1);

    if (fallback.length === 0) {
      throw new Error(`Failed to get or create wallet for userId ${userId}`);
    }

    return fallback[0].id;
  }
}
