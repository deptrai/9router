import { Injectable } from '@nestjs/common';
import { db, eq, users } from '@repo/database';
import type { TelegramUserDto } from '@repo/shared-types';

@Injectable()
export class UsersService {
  async upsertByTelegram(dto: TelegramUserDto): Promise<string> {
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.telegramId, dto.id))
      .limit(1);

    if (existing.length > 0) {
      const user = existing[0];
      if (
        user.firstName !== dto.firstName ||
        user.lastName !== dto.lastName ||
        user.username !== dto.username
      ) {
        await db
          .update(users)
          .set({
            firstName: dto.firstName,
            lastName: dto.lastName ?? null,
            username: dto.username ?? null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));
      }
      return user.id;
    }

    const [created] = await db
      .insert(users)
      .values({
        telegramId: dto.id,
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        username: dto.username ?? null,
        role: 'CUSTOMER',
      })
      .returning();

    return created.id;
  }
}
