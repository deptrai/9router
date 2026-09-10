import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { db, eq, users, sql, type DbOrTx } from '@repo/database';
import type { TelegramUserDto } from '@repo/shared-types';

type UserRecord = typeof users.$inferSelect;

@Injectable()
export class UsersService {
  async upsertByTelegram(dto: TelegramUserDto, tx: DbOrTx = db): Promise<UserRecord> {
    const [user] = await tx
      .insert(users)
      .values({
        telegramId: dto.id,
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        username: dto.username ?? null,
        languageCode: dto.languageCode ? dto.languageCode.slice(0, 35) : null,
        isPremium: Boolean(dto.isPremium),
        role: 'CUSTOMER',
      })
      .onConflictDoUpdate({
        target: users.telegramId,
        set: {
          firstName: dto.firstName,
          lastName: dto.lastName ?? null,
          username: dto.username ?? null,
          languageCode: dto.languageCode ? dto.languageCode.slice(0, 35) : null,
          isPremium: Boolean(dto.isPremium),
          updatedAt: sql`now()`,
        },
      })
      .returning();

    if (!user) {
      throw new InternalServerErrorException({
        errorCode: 'USER_UPSERT_FAILED',
        message: 'Failed to upsert user',
      });
    }

    return user;
  }
}
