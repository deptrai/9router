import { test } from 'node:test';
import assert from 'node:assert';
import { WalletsService } from './wallets.service';
import type { DbOrTx } from '@repo/database';

function makeWalletRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wallet-uuid-123',
    userId: 'user-uuid-123',
    balance: '0.00',
    heldBalance: '0.00',
    currency: 'VND',
    createdAt: new Date('2026-09-10T10:00:00.000Z'),
    updatedAt: new Date('2026-09-10T10:00:00.000Z'),
    ...overrides,
  };
}

test('WalletsService.getOrCreateByUserId returns existing wallet id', async () => {
  const existingWallet = makeWalletRecord({ id: 'existing-wallet-id' });
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (n: number) => [existingWallet].slice(0, n),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => [],
        }),
      }),
    }),
  } as any;

  const service = new WalletsService();
  const walletId = await service.getOrCreateByUserId('user-uuid-123', tx);
  assert.strictEqual(walletId, 'existing-wallet-id');
});

test('WalletsService.getOrCreateByUserId creates new wallet with default 0.00 VND when not found', async () => {
  const createdWallet = makeWalletRecord({ id: 'new-wallet-id' });
  let insertValues: any = null;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => [],
        }),
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        insertValues = v;
        return {
          onConflictDoNothing: () => ({
            returning: () => [createdWallet],
          }),
        };
      },
    }),
  } as any;

  const service = new WalletsService();
  const walletId = await service.getOrCreateByUserId('user-uuid-123', tx);
  assert.strictEqual(walletId, 'new-wallet-id');
  assert.ok(insertValues, 'should call insert with values');
  assert.strictEqual(insertValues.userId, 'user-uuid-123');
  assert.strictEqual(insertValues.balance, '0.00');
  assert.strictEqual(insertValues.heldBalance, '0.00');
  assert.strictEqual(insertValues.currency, 'VND');
});

test('WalletsService.getOrCreateByUserId handles race condition via fallback SELECT', async () => {
  // Simulate: existing check empty, insert returns empty (race), fallback SELECT returns wallet
  const fallbackWallet = makeWalletRecord({ id: 'race-wallet-id' });
  let selectCallCount = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            selectCallCount++;
            if (selectCallCount === 1) return []; // initial check
            return [fallbackWallet]; // fallback after race
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => [],
        }),
      }),
    }),
  } as any;

  const service = new WalletsService();
  const walletId = await service.getOrCreateByUserId('user-uuid-123', tx);
  assert.strictEqual(walletId, 'race-wallet-id');
});

test('WalletsService.getOrCreateByUserId throws when fallback SELECT returns nothing', async () => {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => [],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => [],
        }),
      }),
    }),
  } as any;

  const service = new WalletsService();
  await assert.rejects(
    () => service.getOrCreateByUserId('user-uuid-123', tx),
    /Failed to get or create wallet for userId/,
  );
});
