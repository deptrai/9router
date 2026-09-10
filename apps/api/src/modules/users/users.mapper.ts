import { users, wallets } from '@repo/database';
import type { UserDto, WalletDto } from '@repo/shared-types';
import { UserRole } from '@repo/shared-types';

type UserRecord = typeof users.$inferSelect;
type WalletRecord = typeof wallets.$inferSelect;

export function toUserDto(record: UserRecord): UserDto {
  return {
    id: record.id,
    telegramId: record.telegramId,
    username: record.username ?? null,
    firstName: record.firstName ?? null,
    lastName: record.lastName ?? null,
    languageCode: record.languageCode ?? null,
    isPremium: record.isPremium ?? false,
    role: record.role as UserRole,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toWalletDto(record: WalletRecord): WalletDto {
  return {
    id: record.id,
    userId: record.userId,
    balance: String(record.balance),
    heldBalance: String(record.heldBalance),
    currency: record.currency,
    updatedAt: record.updatedAt.toISOString(),
  };
}
