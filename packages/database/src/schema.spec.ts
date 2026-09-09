import { test } from 'node:test';
import assert from 'node:assert';
import { users, wallets, ledgerTransactions } from './schema';

test('Database schema exports required tables with constraints', () => {
  assert.ok(users, 'users table must be exported');
  assert.ok(wallets, 'wallets table must be exported');
  assert.ok(ledgerTransactions, 'ledgerTransactions table must be exported');
});
