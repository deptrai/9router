import { test } from 'node:test';
import assert from 'node:assert';
import { LedgerService } from './ledger.service';
import { InsufficientFundsException } from '../../common/exceptions/insufficient-funds.exception';
import { NotFoundException, InternalServerErrorException } from '@nestjs/common';
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
  metadata: null,
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
};

const debitLedgerRecord = {
  id: 'ledger-uuid-2',
  walletId: 'wallet-uuid-123',
  type: LedgerType.STORE_PURCHASE,
  amount: '-50.00',
  balanceBefore: '100.00',
  balanceAfter: '50.00',
  referenceId: 'ref-2',
  idempotencyKey: 'idem-2',
  metadata: null,
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
};

interface TxOverrides {
  walletRows?: any[];
  updateRows?: any[];
  insertRows?: any[];
  idempotencyRows?: any[];
  capturedInsertValues?: { value: any };
  capturedUpdateSet?: { value: any };
  updateThrows?: any;
  insertThrows?: any;
}

function tableName(table: any): string | undefined {
  return table?.[Symbol.for('drizzle:Name')] ?? table?.name;
}

function createFullTx(overrides: TxOverrides = {}): DbOrTx {
  const {
    walletRows = [walletRecord],
    updateRows = [{ ...walletRecord, balance: '200.00' }],
    insertRows = [ledgerRecord],
    idempotencyRows = [],
    capturedInsertValues,
    capturedUpdateSet,
    updateThrows,
    insertThrows,
  } = overrides;

  let ledgerCheckCount = 0;

  return {
    select: () => ({
      from: (table: any) => ({
        where: () => {
          const name = tableName(table);
          const fromWallets = name === 'wallets';
          const fromLedger = name === 'ledger_transactions';
          if (fromLedger) {
            ledgerCheckCount++;
            // First idempotency check: use provided idempotencyRows; if empty, first call no record; second call (23505 retry) returns ledgerRecord
            if (idempotencyRows.length === 0 && ledgerCheckCount === 2) {
              return {
                limit: (_n: number) => Promise.resolve([ledgerRecord]),
                for: (_mode: string) => Promise.resolve([ledgerRecord]),
              };
            }
            return {
              limit: (_n: number) => Promise.resolve(idempotencyRows),
              for: (_mode: string) => Promise.resolve(idempotencyRows),
            };
          }
          return {
            limit: (_n: number) => Promise.resolve(walletRows),
            for: (_mode: string) => Promise.resolve(walletRows),
          };
        },
      }),
    }),
    update: (table: any) => ({
      set: (s: any) => {
        if (capturedUpdateSet) capturedUpdateSet.value = s;
        return {
          where: () => {
            if (updateThrows) throw updateThrows;
            return Promise.resolve(updateRows);
          },
        };
      },
    }),
    insert: (table: any) => ({
      values: (v: any) => {
        if (capturedInsertValues) capturedInsertValues.value = v;
        return {
          returning: () => {
            if (insertThrows) throw insertThrows;
            const rows = insertRows.map((r) => ({ ...r, ...v }));
            return Promise.resolve(rows);
          },
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
    tx,
  );

  assert.strictEqual(result.walletId, 'wallet-uuid-123');
  assert.strictEqual(result.type, LedgerType.TOPUP_VIETQR);
  assert.strictEqual(result.amount, '100.00');
  assert.strictEqual(result.balanceBefore, '100.00');
  assert.strictEqual(result.balanceAfter, '200.00');
  assert.strictEqual(result.referenceId, 'ref-1');
  assert.strictEqual(result.idempotencyKey, 'idem-1');

  assert.strictEqual(capturedUpdateSet.value.balance, '200.00');
  assert.strictEqual(capturedInsertValues.value.walletId, 'wallet-uuid-123');
  assert.strictEqual(capturedInsertValues.value.balanceBefore, '100.00');
  assert.strictEqual(capturedInsertValues.value.balanceAfter, '200.00');
  assert.strictEqual(capturedInsertValues.value.amount, '100.00');
});

test('LedgerService.debit decreases wallet balance and returns ledger record', async () => {
  const capturedInsertValues: { value: any } = { value: null };
  const capturedUpdateSet: { value: any } = { value: null };
  const tx = createFullTx({
    updateRows: [{ ...walletRecord, balance: '50.00' }],
    insertRows: [debitLedgerRecord],
    capturedInsertValues,
    capturedUpdateSet,
  });
  const service = new LedgerService();
  const result = await service.debit(
    'wallet-uuid-123',
    '50.00',
    LedgerType.STORE_PURCHASE,
    'idem-2',
    'ref-2',
    tx,
  );

  assert.strictEqual(result.walletId, 'wallet-uuid-123');
  assert.strictEqual(result.type, LedgerType.STORE_PURCHASE);
  assert.strictEqual(result.amount, '-50.00');
  assert.strictEqual(result.balanceBefore, '100.00');
  assert.strictEqual(result.balanceAfter, '50.00');
  assert.strictEqual(result.referenceId, 'ref-2');
  assert.strictEqual(result.idempotencyKey, 'idem-2');

  assert.strictEqual(capturedUpdateSet.value.balance, '50.00');
  assert.strictEqual(capturedInsertValues.value.amount, '-50.00');
});

test('LedgerService.debit throws InsufficientFundsException when balance goes negative', async () => {
  const tx = createFullTx();
  const service = new LedgerService();
  await assert.rejects(
    () => service.debit('wallet-uuid-123', '100.01', LedgerType.STORE_PURCHASE, 'idem-3', 'ref-3', tx),
    (err: any) => err instanceof InsufficientFundsException,
  );
});

test('LedgerService.debit allows exact spend down to zero balance', async () => {
  const capturedUpdateSet: { value: any } = { value: null };
  const zeroWallet = { ...walletRecord, balance: '50.00' };
  const tx = createFullTx({
    walletRows: [zeroWallet],
    updateRows: [{ ...zeroWallet, balance: '0.00' }],
    insertRows: [{ ...debitLedgerRecord, balanceBefore: '50.00', balanceAfter: '0.00' }],
    capturedUpdateSet,
  });
  const service = new LedgerService();
  const result = await service.debit('wallet-uuid-123', '50.00', LedgerType.STORE_PURCHASE, 'idem-4', null, tx);
  assert.strictEqual(result.balanceAfter, '0.00');
  assert.strictEqual(capturedUpdateSet.value.balance, '0.00');
});

test('LedgerService.credit returns existing record for duplicate idempotency key without updating wallet', async () => {
  const existing = {
    ...ledgerRecord,
    amount: '100.00',
    createdAt: ledgerRecord.createdAt,
  };
  const capturedUpdateSet: { value: any } = { value: null };
  const capturedInsertValues: { value: any } = { value: null };
  const tx = createFullTx({ idempotencyRows: [existing], capturedUpdateSet, capturedInsertValues });
  const service = new LedgerService();
  const result = await service.credit(
    'wallet-uuid-123',
    '999.00',
    LedgerType.TOPUP_VIETQR,
    'idem-1',
    null,
    tx,
  );
  assert.strictEqual(result.idempotencyKey, 'idem-1');
  assert.strictEqual(result.amount, '100.00');
  assert.strictEqual(result.balanceAfter, '200.00');
  assert.strictEqual(capturedUpdateSet.value, null);
  assert.strictEqual(capturedInsertValues.value, null);
});

test('LedgerService.debit throws NotFoundException for missing wallet', async () => {
  const tx = createFullTx({ walletRows: [] });
  const service = new LedgerService();
  await assert.rejects(
    () => service.debit('missing-wallet', '10.00', LedgerType.STORE_PURCHASE, 'idem-5', null, tx),
    (err: any) => err instanceof NotFoundException && (err.getResponse() as any).errorCode === 'WALLET_NOT_FOUND',
  );
});

test('LedgerService.credit rejects invalid amount strings', async () => {
  const tx = createFullTx();
  const service = new LedgerService();
  await assert.rejects(
    () => service.credit('wallet-uuid-123', '-50.00', LedgerType.TOPUP_VIETQR, 'idem-6', null, tx),
    (err: any) => err instanceof InternalServerErrorException && (err.getResponse() as any).errorCode === 'INVALID_LEDGER_AMOUNT',
  );
  await assert.rejects(
    () => service.credit('wallet-uuid-123', 'not-a-number', LedgerType.TOPUP_VIETQR, 'idem-7', null, tx),
    (err: any) => err instanceof InternalServerErrorException && (err.getResponse() as any).errorCode === 'INVALID_LEDGER_AMOUNT',
  );
});

test('LedgerService translates PostgreSQL check constraint violation to InsufficientFundsException', async () => {
  const err: any = new Error('balance_non_negative check constraint violated');
  err.code = '23514';
  const tx = createFullTx({ updateThrows: err });
  const service = new LedgerService();
  await assert.rejects(
    () => service.debit('wallet-uuid-123', '100.00', LedgerType.STORE_PURCHASE, 'idem-8', null, tx),
    (e: any) => e instanceof InsufficientFundsException,
  );
});

test('LedgerService handles unique idempotency key race by returning existing record', async () => {
  const err: any = new Error('duplicate key value violates unique constraint "ledger_transactions_idempotency_key_unique"');
  err.code = '23505';
  const tx = createFullTx({ insertThrows: err });
  const service = new LedgerService();
  const result = await service.credit('wallet-uuid-123', '100.00', LedgerType.TOPUP_VIETQR, 'idem-1', 'ref-1', tx);
  assert.strictEqual(result.idempotencyKey, 'idem-1');
});

test('LedgerService.hold moves funds from balance to heldBalance', async () => {
  const capturedUpdateSet = { value: null };
  const tx = createFullTx({
    walletRows: [{ ...walletRecord, balance: '100.00', heldBalance: '0.00' }],
    capturedUpdateSet,
  });
  const service = new LedgerService();
  const res = await service.hold('wallet-uuid-123', '30.00', 'hold-idem-1', 'order-1', tx);
  assert.strictEqual(res.type, LedgerType.HOLD);
  assert.strictEqual(capturedUpdateSet.value.balance, '70.00');
  assert.strictEqual(capturedUpdateSet.value.heldBalance, '30.00');
});

test('LedgerService.releaseHold restores funds from heldBalance back to balance', async () => {
  const capturedUpdateSet = { value: null };
  const tx = createFullTx({
    walletRows: [{ ...walletRecord, balance: '70.00', heldBalance: '30.00' }],
    capturedUpdateSet,
  });
  const service = new LedgerService();
  const res = await service.releaseHold('wallet-uuid-123', '30.00', 'release-idem-1', 'order-1', tx);
  assert.strictEqual(res.type, LedgerType.RELEASE_HOLD);
  assert.strictEqual(capturedUpdateSet.value.balance, '100.00');
  assert.strictEqual(capturedUpdateSet.value.heldBalance, '0.00');
});

test('LedgerService.captureHold burns funds from heldBalance', async () => {
  const capturedUpdateSet = { value: null };
  const tx = createFullTx({
    walletRows: [{ ...walletRecord, balance: '70.00', heldBalance: '30.00' }],
    capturedUpdateSet,
  });
  const service = new LedgerService();
  const res = await service.captureHold('wallet-uuid-123', '30.00', 'capture-idem-1', 'order-1', tx);
  assert.strictEqual(res.type, LedgerType.CAPTURE_HOLD);
  assert.strictEqual(capturedUpdateSet.value.heldBalance, '0.00');
});

