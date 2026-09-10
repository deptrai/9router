import { users, wallets } from '@repo/database';
import type { UserDto, WalletDto } from '@repo/shared-types';
import { UserRole } from '@repo/shared-types';

type UserRecord = typeof users.$inferSelect;
type WalletRecord = typeof wallets.$inferSelect;

function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return new Date(value as any).toISOString();
}

function normalizeRole(value: string): UserRole {
  if (Object.values(UserRole).includes(value as UserRole)) {
    return value as UserRole;
  }
  return UserRole.CUSTOMER;
}

export function toUserDto(record: UserRecord): UserDto {
  return {
    id: record.id,
    telegramId: record.telegramId,
    username: record.username ?? null,
    firstName: record.firstName ?? null,
    lastName: record.lastName ?? null,
    languageCode: record.languageCode ?? null,
    isPremium: record.isPremium ?? false,
    role: normalizeRole(record.role),
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt),
  };
}

export function toWalletDto(record: WalletRecord): WalletDto {
  return {
    id: record.id,
    userId: record.userId,
    balance: String(record.balance),
    heldBalance: String(record.heldBalance),
    currency: record.currency,
    updatedAt: toIsoString(record.updatedAt),
  };
}
