import { Injectable } from '@nestjs/common';
import { db, eq, wallets } from '@repo/database';

@Injectable()
export class WalletsService {
  async getOrCreateByUserId(userId: string): Promise<string> {
    const existing = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      return existing[0].id;
    }

    const [created] = await db
      .insert(wallets)
      .values({
        userId,
        balance: '0.00',
        heldBalance: '0.00',
        currency: 'VND',
      })
      .returning();

    return created.id;
  }
}
