import { test } from 'node:test';
import assert from 'node:assert';
import { UsersController } from './users.controller';
import type { TelegramUserDto, UserDto, WalletDto } from '@repo/shared-types';

const telegramUser: TelegramUserDto = {
  id: 987654321,
  username: 'johndoe',
  firstName: 'John',
  lastName: 'Doe',
  languageCode: 'vi',
  isPremium: true,
};

const userDto: UserDto = {
  id: 'uuid-123',
  telegramId: 987654321,
  username: 'johndoe',
  firstName: 'John',
  lastName: 'Doe',
  languageCode: 'vi',
  isPremium: true,
  role: 'CUSTOMER' as any,
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z',
};

const walletDto: WalletDto = {
  id: 'wallet-uuid-123',
  userId: 'uuid-123',
  balance: '0.00',
  heldBalance: '0.00',
  currency: 'VND',
  updatedAt: '2026-09-10T10:00:00.000Z',
};

function createMockUserWalletService() {
  return {
    upsertUserAndWallet: async (dto: TelegramUserDto): Promise<{ user: UserDto; wallet: WalletDto }> => {
      assert.strictEqual(dto.id, telegramUser.id);
      return { user: userDto, wallet: walletDto };
    },
  } as any;
}

test('UsersController.getMe returns ok with UserDto and WalletDto', async () => {
  const mockService = createMockUserWalletService();
  const controller = new UsersController(mockService);
  const result = await controller.getMe(telegramUser);

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.user, userDto);
  assert.deepStrictEqual(result.wallet, walletDto);
  // Verify it's UserDto (not TelegramUserDto) — has UUID id, role, createdAt
  assert.strictEqual(result.user.id, 'uuid-123');
  assert.strictEqual(result.user.role, 'CUSTOMER');
  assert.ok(result.user.createdAt);
});

test('UsersController.getMe returns wallet with string balance (not number)', async () => {
  const mockService = createMockUserWalletService();
  const controller = new UsersController(mockService);
  const result = await controller.getMe(telegramUser);

  assert.strictEqual(typeof result.wallet.balance, 'string');
  assert.strictEqual(typeof result.wallet.heldBalance, 'string');
});

test('UsersController.getMe passes TelegramUserDto through to service and returns same DTOs', async () => {
  const mockService = createMockUserWalletService();
  const controller = new UsersController(mockService);
  const first = await controller.getMe(telegramUser);
  const second = await controller.getMe(telegramUser);

  assert.deepStrictEqual(first, second);
});
