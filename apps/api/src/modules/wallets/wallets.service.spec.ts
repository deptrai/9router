import { test } from 'node:test';
import assert from 'node:assert';
import { WalletsService } from './wallets.service';
import { InternalServerErrorException } from '@nestjs/common';
import type { DbOrTx } from '@repo/database';
import { LedgerType } from '@repo/shared-types';

const walletRecord = {
  id: 'wallet-uuid-123',
  userId: 'user-uuid-123',
  balance: '0.00',
  heldBalance: '0.00',
  currency: 'VND',
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
  updatedAt: new Date('2026-09-10T10:00:00.000Z'),
};

const ledgerRecord = {
  id: 'ledger-uuid-1',
  walletId: 'wallet-uuid-123',
  type: LedgerType.TOPUP_VIETQR,
  amount: '100.00',
  balanceBefore: '0.00',
  balanceAfter: '100.00',
  referenceId: 'ref-1',
  idempotencyKey: 'idem-1',
  metadata: null,
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
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

function createLedgerServiceMock() {
  return {
    credit: async (...args: any[]) => ({
      id: 'ledger-uuid-credit',
      walletId: args[0],
      type: args[2],
      amount: args[1],
      balanceBefore: '0.00',
      balanceAfter: args[1],
      referenceId: args[4] ?? null,
      idempotencyKey: args[3],
      metadata: null,
      createdAt: new Date().toISOString(),
    }),
    debit: async (...args: any[]) => ({
      id: 'ledger-uuid-debit',
      walletId: args[0],
      type: args[2],
      amount: args[1],
      balanceBefore: args[1],
      balanceAfter: '0.00',
      referenceId: args[4] ?? null,
      idempotencyKey: args[3],
      metadata: null,
      createdAt: new Date().toISOString(),
    }),
    getByIdempotencyKey: async () => null,
  };
}

test('WalletsService.getOrCreateByUserId returns wallet from atomic upsert', async () => {
  const tx = createMockTx([walletRecord]);
  const service = new WalletsService(createLedgerServiceMock() as any);
  const result = await service.getOrCreateByUserId('user-uuid-123', tx);
  assert.deepStrictEqual(result, walletRecord);
});

test('WalletsService.getOrCreateByUserId throws InternalServerErrorException when upsert fails', async () => {
  const tx = createMockTx([]);
  const service = new WalletsService(createLedgerServiceMock() as any);
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

  const service = new WalletsService(createLedgerServiceMock() as any);
  await service.getOrCreateByUserId('user-uuid-123', tx);
  assert.strictEqual(values.userId, 'user-uuid-123');
  assert.strictEqual(values.balance, '0.00');
  assert.strictEqual(values.heldBalance, '0.00');
  assert.strictEqual(values.currency, 'VND');
});

test('WalletsService.credit delegates to LedgerService.credit with correct parameters including tx', async () => {
  const ledgerMock = createLedgerServiceMock();
  let creditArgs: any[] | null = null;
  const mockTx = { id: 'mock-tx' } as any;
  ledgerMock.credit = async (...args: any[]) => {
    creditArgs = args;
    return ledgerRecord;
  };

  const service = new WalletsService(ledgerMock as any);
  const result = await service.credit(
    'wallet-uuid-123',
    '100.00',
    LedgerType.TOPUP_VIETQR,
    'idem-1',
    'ref-1',
    mockTx,
  );

  assert.deepStrictEqual(result, ledgerRecord);
  assert.strictEqual(creditArgs?.[0], 'wallet-uuid-123');
  assert.strictEqual(creditArgs?.[1], '100.00');
  assert.strictEqual(creditArgs?.[2], LedgerType.TOPUP_VIETQR);
  assert.strictEqual(creditArgs?.[3], 'idem-1');
  assert.strictEqual(creditArgs?.[4], 'ref-1');
  assert.strictEqual(creditArgs?.[5], mockTx);
});

test('WalletsService.debit delegates to LedgerService.debit with correct parameters including tx', async () => {
  const ledgerMock = createLedgerServiceMock();
  let debitArgs: any[] | null = null;
  const mockTx = { id: 'mock-tx' } as any;
  ledgerMock.debit = async (...args: any[]) => {
    debitArgs = args;
    return ledgerRecord;
  };

  const service = new WalletsService(ledgerMock as any);
  const result = await service.debit(
    'wallet-uuid-123',
    '100.00',
    LedgerType.STORE_PURCHASE,
    'idem-2',
    'ref-2',
    mockTx,
  );

  assert.deepStrictEqual(result, ledgerRecord);
  assert.strictEqual(debitArgs?.[0], 'wallet-uuid-123');
  assert.strictEqual(debitArgs?.[1], '100.00');
  assert.strictEqual(debitArgs?.[2], LedgerType.STORE_PURCHASE);
  assert.strictEqual(debitArgs?.[3], 'idem-2');
  assert.strictEqual(debitArgs?.[4], 'ref-2');
  assert.strictEqual(debitArgs?.[5], mockTx);
});
