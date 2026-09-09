import { test } from 'node:test';
import assert from 'node:assert';
import { UserRole, OrderStatus, ProductSourcingMode, TelegramUserDto, TelegramInitDataResult } from './index';

test('Shared types exports valid enums matching Architecture Spine', () => {
  assert.strictEqual(UserRole.CUSTOMER, 'CUSTOMER');
  assert.strictEqual(OrderStatus.PENDING, 'PENDING');
  assert.strictEqual(OrderStatus.SOURCING, 'SOURCING');
  assert.strictEqual(OrderStatus.FULFILLED, 'FULFILLED');
  assert.strictEqual(ProductSourcingMode.IN_HOUSE, 'IN_HOUSE');
});

test('Shared types exports Telegram auth interfaces', () => {
  const mockUser: TelegramUserDto = {
    id: 123456789,
    firstName: 'Alice',
    username: 'alice_tg',
    isPremium: true,
  };
  const mockResult: TelegramInitDataResult = {
    ok: true,
    user: mockUser,
    authDate: 1700000000,
  };
  assert.strictEqual(mockResult.ok, true);
  assert.strictEqual(mockResult.user?.id, 123456789);
});
