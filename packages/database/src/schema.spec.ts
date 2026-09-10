import { test } from 'node:test';
import assert from 'node:assert';
import { users, wallets, ledgerTransactions } from './schema';

test('Database schema exports required tables with constraints', () => {
  assert.ok(users, 'users table must be exported');
  assert.ok(wallets, 'wallets table must be exported');
  assert.ok(ledgerTransactions, 'ledgerTransactions table must be exported');
  assert.ok('languageCode' in users, 'users table must have languageCode column');
  assert.ok('isPremium' in users, 'users table must have isPremium column');
});

test('wallets table has non-negative balance check constraints', () => {
  const table = wallets as any;
  const builder = table[Symbol.for('drizzle:ExtraConfigBuilder')];
  const checks = typeof builder === 'function' ? builder(table) : [];
  const checkNames = checks.map((c: any) => c?.name).filter(Boolean);
  assert.ok(checkNames.includes('balance_non_negative'), 'must have balance_non_negative check');
  assert.ok(checkNames.includes('held_balance_non_negative'), 'must have held_balance_non_negative check');
});

test('ledgerTransactions table has required columns', () => {
  assert.ok('id' in ledgerTransactions, 'must have id');
  assert.ok('walletId' in ledgerTransactions, 'must have walletId');
  assert.ok('type' in ledgerTransactions, 'must have type');
  assert.ok('amount' in ledgerTransactions, 'must have amount');
  assert.ok('balanceBefore' in ledgerTransactions, 'must have balanceBefore');
  assert.ok('balanceAfter' in ledgerTransactions, 'must have balanceAfter');
  assert.ok('referenceId' in ledgerTransactions, 'must have referenceId');
  assert.ok('idempotencyKey' in ledgerTransactions, 'must have idempotencyKey');
  assert.ok('metadata' in ledgerTransactions, 'must have metadata');
  assert.ok('createdAt' in ledgerTransactions, 'must have createdAt');
});
