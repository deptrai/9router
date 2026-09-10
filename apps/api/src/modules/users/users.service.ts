import { Injectable } from '@nestjs/common';
import { db, eq, users, type DbOrTx } from '@repo/database';
import type { TelegramUserDto } from '@repo/shared-types';

@Injectable()
export class UsersService {
  async upsertByTelegram(dto: TelegramUserDto, tx: DbOrTx = db): Promise<string> {
    const existing = await tx
      .select()
      .from(users)
      .where(eq(users.telegramId, dto.id))
      .limit(1);

    if (existing.length > 0) {
      const user = existing[0];
      if (
        user.firstName !== dto.firstName ||
        user.lastName !== dto.lastName ||
        user.username !== dto.username ||
        user.languageCode !== dto.languageCode ||
        user.isPremium !== Boolean(dto.isPremium)
      ) {
        await tx
          .update(users)
          .set({
            firstName: dto.firstName,
            lastName: dto.lastName ?? null,
            username: dto.username ?? null,
            languageCode: dto.languageCode ?? null,
            isPremium: Boolean(dto.isPremium),
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));
      }
      return user.id;
    }

    const [created] = await tx
      .insert(users)
      .values({
        telegramId: dto.id,
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        username: dto.username ?? null,
        languageCode: dto.languageCode ?? null,
        isPremium: Boolean(dto.isPremium),
        role: 'CUSTOMER',
      })
      .onConflictDoNothing({ target: users.telegramId })
      .returning();

    if (created) {
      return created.id;
    }

    // Race condition: another transaction inserted the same telegramId
    const fallback = await tx
      .select()
      .from(users)
      .where(eq(users.telegramId, dto.id))
      .limit(1);

    if (fallback.length === 0) {
      throw new Error(`Failed to upsert user for telegramId ${dto.id}`);
    }

    const user = fallback[0];
    if (
      user.firstName !== dto.firstName ||
      user.lastName !== dto.lastName ||
      user.username !== dto.username ||
      user.languageCode !== dto.languageCode ||
      user.isPremium !== Boolean(dto.isPremium)
    ) {
      await tx
        .update(users)
        .set({
          firstName: dto.firstName,
          lastName: dto.lastName ?? null,
          username: dto.username ?? null,
          languageCode: dto.languageCode ?? null,
          isPremium: Boolean(dto.isPremium),
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
    }

    return user.id;
  }
}
