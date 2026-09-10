import { test } from 'node:test';
import assert from 'node:assert';
import { WalletsService } from './wallets.service';
import { InternalServerErrorException } from '@nestjs/common';
import type { DbOrTx } from '@repo/database';

const walletRecord = {
  id: 'wallet-uuid-123',
  userId: 'user-uuid-123',
  balance: '0.00',
  heldBalance: '0.00',
  currency: 'VND',
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
  updatedAt: new Date('2026-09-10T10:00:00.000Z'),
};

function createMockTx(returning: any[]): DbOrTx {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => returning,
        }),
      }),
    }),
  } as any;
}

test('WalletsService.getOrCreateByUserId returns wallet from atomic upsert', async () => {
  const tx = createMockTx([walletRecord]);
  const service = new WalletsService();
  const result = await service.getOrCreateByUserId('user-uuid-123', tx);
  assert.deepStrictEqual(result, walletRecord);
});

test('WalletsService.getOrCreateByUserId throws InternalServerErrorException when upsert fails', async () => {
  const tx = createMockTx([]);
  const service = new WalletsService();
  await assert.rejects(
    () => service.getOrCreateByUserId('user-uuid-123', tx),
    (err: any) =>
      err instanceof InternalServerErrorException &&
      err.getResponse &&
      (err.getResponse() as any).errorCode === 'WALLET_GET_OR_CREATE_FAILED',
  );
});

test('WalletsService.getOrCreateByUserId creates wallet with VND and zero balance', async () => {
  let values: any = null;
  const tx = {
    insert: () => ({
      values: (v: any) => {
        values = v;
        return {
          onConflictDoUpdate: () => ({
            returning: () => [walletRecord],
          }),
        };
      },
    }),
  } as any;

  const service = new WalletsService();
  await service.getOrCreateByUserId('user-uuid-123', tx);
  assert.strictEqual(values.userId, 'user-uuid-123');
  assert.strictEqual(values.balance, '0.00');
  assert.strictEqual(values.heldBalance, '0.00');
  assert.strictEqual(values.currency, 'VND');
});
