import { test } from 'node:test';
import assert from 'node:assert';
import { InternalServerErrorException } from '@nestjs/common';
import { UserWalletService } from './user-wallet.service';
import { UsersService } from './users.service';
import { WalletsService } from '../wallets/wallets.service';
import type { TelegramUserDto, UserDto, WalletDto } from '@repo/shared-types';
import { UserRole } from '@repo/shared-types';

const dto: TelegramUserDto = {
  id: 987654321,
  username: 'johndoe',
  firstName: 'John',
  lastName: 'Doe',
  languageCode: 'vi',
  isPremium: true,
};

const userRecord = {
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
};

const walletRecord = {
  id: 'wallet-uuid-123',
  userId: 'uuid-123',
  balance: '0.00',
  heldBalance: '0.00',
  currency: 'VND',
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
  updatedAt: new Date('2026-09-10T10:00:00.000Z'),
};

function createServices(records: { user: any; wallet: any }) {
  const usersService = {
    upsertByTelegram: async () => records.user,
  } as any as UsersService;

  const walletsService = {
    getOrCreateByUserId: async () => records.wallet,
  } as any as WalletsService;

  return { usersService, walletsService };
}

test('UserWalletService.upsertUserAndWallet returns UserDto and WalletDto', async () => {
  const { usersService, walletsService } = createServices({ user: userRecord, wallet: walletRecord });
  const service = new UserWalletService(usersService, walletsService);
  const { user, wallet } = await service.upsertUserAndWallet(dto);

  assert.strictEqual(user.id, 'uuid-123');
  assert.strictEqual(user.role, UserRole.CUSTOMER);
  assert.strictEqual(user.createdAt, '2026-09-10T10:00:00.000Z');
  assert.strictEqual(wallet.userId, 'uuid-123');
  assert.strictEqual(wallet.balance, '0.00');
});

test('UserWalletService.upsertUserAndWallet throws when user is missing', async () => {
  const { usersService, walletsService } = createServices({ user: null, wallet: walletRecord });
  const service = new UserWalletService(usersService, walletsService);
  await assert.rejects(
    () => service.upsertUserAndWallet(dto),
    (err: any) => err instanceof InternalServerErrorException && err.message === 'Failed to onboard user and wallet',
  );
});

test('UserWalletService.upsertUserAndWallet throws when wallet is missing', async () => {
  const { usersService, walletsService } = createServices({ user: userRecord, wallet: null });
  const service = new UserWalletService(usersService, walletsService);
  await assert.rejects(
    () => service.upsertUserAndWallet(dto),
    (err: any) => err instanceof InternalServerErrorException && err.message === 'Failed to onboard user and wallet',
  );
});

test('UserWalletService.upsertUserAndWallet uses outer transaction when provided', async () => {
  const tx = {} as any;
  const childTx = {} as any;
  const mockDb = {
    transaction: async (fn: any) => fn(childTx),
  } as any;

  let receivedRunner: any = null;
  let receivedChildTx: any = null;

  // Since service uses `runner ?? db`, we simulate passing an outer tx
  // by overriding the constructor injection to accept a mock db-like runner.
  // Instead, we test at the public API level: when an outerTx with .transaction
  // is passed, the upsert callback is executed inside that transaction.
  const usersService = {
    upsertByTelegram: async (_: any, t: any) => {
      receivedChildTx = t;
      return userRecord;
    },
  } as any as UsersService;

  const walletsService = {
    getOrCreateByUserId: async () => walletRecord,
  } as any as WalletsService;

  const service = new UserWalletService(usersService, walletsService);
  await (service as any).upsertUserAndWallet(dto, mockDb);
  assert.strictEqual(receivedChildTx, childTx);
});
