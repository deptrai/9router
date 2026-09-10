import { test } from 'node:test';
import assert from 'node:assert';
import { LedgerService } from './ledger.service';
import { InsufficientFundsException } from '../../common/exceptions/insufficient-funds.exception';
import { InternalServerErrorException } from '@nestjs/common';
import type { DbOrTx } from '@repo/database';
import { ledgerTransactions, wallets } from '@repo/database';
import { LedgerType } from '@repo/shared-types';

const walletRecord = {
  id: 'wallet-uuid-123',
  userId: 'user-uuid-123',
  balance: '100.00',
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
  balanceBefore: '100.00',
  balanceAfter: '200.00',
  referenceId: 'ref-1',
  idempotencyKey: 'idem-1',
  metadata: { source: 'bank' },
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
};

const debitLedgerRecord = {
  ...ledgerRecord,
  id: 'ledger-uuid-2',
  type: LedgerType.STORE_PURCHASE,
  amount: '-50.00',
  balanceBefore: '100.00',
  balanceAfter: '50.00',
  referenceId: 'ref-2',
  idempotencyKey: 'idem-2',
  metadata: { productId: 'prod-1' },
};

interface TxOverrides {
  walletRows?: any[];
  updateRows?: any[];
  insertRows?: any[];
  idempotencyRows?: any[];
  capturedInsertValues?: { value: any };
  capturedUpdateSet?: { value: any };
}

function createFullTx(overrides: TxOverrides = {}): DbOrTx {
  const {
    walletRows = [walletRecord],
    updateRows = [{ ...walletRecord, balance: '200.00' }],
    insertRows = [ledgerRecord],
    idempotencyRows = [],
    capturedInsertValues,
    capturedUpdateSet,
  } = overrides;

  return {
    select: () => ({
      from: (table: any) => ({
        where: () => {
          const rows = table === ledgerTransactions ? idempotencyRows : walletRows;
          return {
            limit: (_n: number) => Promise.resolve(rows),
            for: (_mode: string) => Promise.resolve(rows),
          };
        },
      }),
    }),
    update: (table: any) => ({
      set: (s: any) => {
        if (capturedUpdateSet) capturedUpdateSet.value = s;
        return {
          where: () => ({
            returning: () => Promise.resolve(updateRows),
          }),
        };
      },
    }),
    insert: (table: any) => ({
      values: (v: any) => {
        if (capturedInsertValues) capturedInsertValues.value = v;
        return {
          returning: () => Promise.resolve(insertRows),
        };
      },
    }),
  } as any;
}

test('LedgerService.credit increases wallet balance and returns ledger record', async () => {
  const capturedInsertValues: { value: any } = { value: null };
  const capturedUpdateSet: { value: any } = { value: null };
  const tx = createFullTx({ capturedInsertValues, capturedUpdateSet });
  const service = new LedgerService();
  const result = await service.credit(
    'wallet-uuid-123',
    '100.00',
    LedgerType.TOPUP_VIETQR,
    'idem-1',
    'ref-1',
    { source: 'bank' },
    tx,
  );

  assert.strictEqual(result.walletId, 'wallet-uuid-123');
  assert.strictEqual(result.type, LedgerType.TOPUP_VIETQR);
  assert.strictEqual(result.amount, '100.00');
  assert.strictEqual(result.balanceBefore, '100.00');
  assert.strictEqual(result.balanceAfter, '200.00');
  assert.strictEqual(result.referenceId, 'ref-1');
  assert.strictEqual(result.idempotencyKey, 'idem-1');
  assert.deepStrictEqual(result.metadata, { source: 'bank' });

  assert.strictEqual(capturedUpdateSet.value.balance, '200.00');
  assert.strictEqual(capturedInsertValues.value.walletId, 'wallet-uuid-123');
  assert.strictEqual(capturedInsertValues.value.balanceBefore, '100.00');
  assert.strictEqual(capturedInsertValues.value.balanceAfter, '200.00');
  assert.strictEqual(capturedInsertValues.value.amount, '100.00');
});

test('LedgerService.debit decreases wallet balance and returns ledger record', async () => {
  const capturedInsertValues: { value: any } = { value: null };
  const capturedUpdateSet: { value: any } = { value: null };
  const tx = createFullTx({ insertRows: [debitLedgerRecord], capturedInsertValues, capturedUpdateSet });
  const service = new LedgerService();
  const result = await service.debit(
    'wallet-uuid-123',
    '50.00',
    LedgerType.STORE_PURCHASE,
    'idem-2',
    'ref-2',
    { productId: 'prod-1' },
    tx,
  );

  assert.strictEqual(result.walletId, 'wallet-uuid-123');
  assert.strictEqual(result.type, LedgerType.STORE_PURCHASE);
  assert.strictEqual(result.amount, '-50.00');
  assert.strictEqual(result.balanceBefore, '100.00');
  assert.strictEqual(result.balanceAfter, '50.00');
  assert.strictEqual(result.referenceId, 'ref-2');
  assert.strictEqual(result.idempotencyKey, 'idem-2');
  assert.deepStrictEqual(result.metadata, { productId: 'prod-1' });

  assert.strictEqual(capturedUpdateSet.value.balance, '50.00');
  assert.strictEqual(capturedInsertValues.value.amount, '-50.00');
});

test('LedgerService.debit throws InsufficientFundsException when balance goes negative', async () => {
  const tx = createFullTx();
  const service = new LedgerService();
  await assert.rejects(
    () => service.debit('wallet-uuid-123', '100.01', LedgerType.STORE_PURCHASE, 'idem-3', 'ref-3', null, tx),
    (err: any) => err instanceof InsufficientFundsException,
  );
});

test('LedgerService.credit returns existing record for duplicate idempotency key', async () => {
  const existing = {
    ...ledgerRecord,
    amount: '100.00',
    createdAt: ledgerRecord.createdAt,
  };
  const tx = createFullTx({ idempotencyRows: [existing] });
  const service = new LedgerService();
  const result = await service.credit(
    'wallet-uuid-123',
    '999.00',
    LedgerType.TOPUP_VIETQR,
    'idem-1',
    null,
    null,
    tx,
  );
  assert.strictEqual(result.idempotencyKey, 'idem-1');
  assert.strictEqual(result.amount, '100.00');
  assert.strictEqual(result.balanceAfter, '200.00');
});

test('LedgerService.debit allows exact spend down to zero balance', async () => {
  const zeroWallet = { ...walletRecord, balance: '50.00' };
  const tx = createFullTx({
    walletRows: [zeroWallet],
    insertRows: [{ ...debitLedgerRecord, balanceBefore: '50.00', balanceAfter: '0.00' }],
  });
  const service = new LedgerService();
  const result = await service.debit('wallet-uuid-123', '50.00', LedgerType.STORE_PURCHASE, 'idem-4', null, null, tx);
  assert.strictEqual(result.balanceAfter, '0.00');
});
