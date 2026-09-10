import { test } from 'node:test';
import assert from 'node:assert';
import { toUserDto, toWalletDto } from './users.mapper';
import { UserRole } from '@repo/shared-types';

test('toUserDto maps UserRecord to UserDto', () => {
  const record = {
    id: 'uuid-123',
    telegramId: 987654321,
    username: 'johndoe',
    firstName: 'John',
    lastName: 'Doe',
    languageCode: 'vi',
    isPremium: true,
    role: 'CUSTOMER',
    createdAt: new Date('2026-09-10T10:00:00.000Z'),
    updatedAt: new Date('2026-09-10T10:00:00.000Z'),
  } as any;

  const dto = toUserDto(record);

  assert.strictEqual(dto.id, 'uuid-123');
  assert.strictEqual(dto.telegramId, 987654321);
  assert.strictEqual(dto.role, UserRole.CUSTOMER);
  assert.strictEqual(dto.createdAt, '2026-09-10T10:00:00.000Z');
});

test('toUserDto accepts string dates', () => {
  const record = {
    id: 'uuid-123',
    telegramId: 987654321,
    username: null,
    firstName: 'John',
    lastName: null,
    languageCode: null,
    isPremium: false,
    role: 'CUSTOMER',
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
  } as any;

  const dto = toUserDto(record);
  assert.strictEqual(dto.createdAt, '2026-09-10T10:00:00.000Z');
  assert.strictEqual(dto.updatedAt, '2026-09-10T10:00:00.000Z');
});

test('toUserDto normalizes invalid role to CUSTOMER', () => {
  const record = {
    id: 'uuid-123',
    telegramId: 987654321,
    username: null,
    firstName: 'John',
    lastName: null,
    languageCode: null,
    isPremium: false,
    role: 'HACKER',
    createdAt: new Date('2026-09-10T10:00:00.000Z'),
    updatedAt: new Date('2026-09-10T10:00:00.000Z'),
  } as any;

  const dto = toUserDto(record);
  assert.strictEqual(dto.role, UserRole.CUSTOMER);
});

test('toWalletDto maps WalletRecord to WalletDto with string balance', () => {
  const record = {
    id: 'wallet-uuid-123',
    userId: 'uuid-123',
    balance: '0.00',
    heldBalance: '0.00',
    currency: 'VND',
    createdAt: new Date('2026-09-10T10:00:00.000Z'),
    updatedAt: new Date('2026-09-10T10:00:00.000Z'),
  } as any;

  const dto = toWalletDto(record);
  assert.strictEqual(dto.balance, '0.00');
  assert.strictEqual(dto.heldBalance, '0.00');
  assert.strictEqual(dto.currency, 'VND');
});
