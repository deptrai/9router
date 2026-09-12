import { test } from 'node:test';
import assert from 'node:assert';
import { users, wallets, ledgerTransactions, paymentTransactions, supplierSources, products, adminAlerts, supplierOrders } from './schema';

test('Database schema exports required tables with constraints', () => {
  assert.ok(users, 'users table must be exported');
  assert.ok(wallets, 'wallets table must be exported');
  assert.ok(ledgerTransactions, 'ledgerTransactions table must be exported');
  assert.ok(paymentTransactions, 'paymentTransactions table must be exported');
  assert.ok(supplierSources, 'supplierSources table must be exported');
  assert.ok(products, 'products table must be exported');
  assert.ok(adminAlerts, 'adminAlerts table must be exported');
  assert.ok(supplierOrders, 'supplierOrders table must be exported');
  assert.ok('orderId' in supplierOrders, 'supplierOrders must have orderId');
  assert.ok('status' in supplierOrders, 'supplierOrders must have status');
  assert.ok('cost' in supplierOrders, 'supplierOrders must have cost');
  assert.ok('languageCode' in users, 'users table must have languageCode column');
  assert.ok('isPremium' in users, 'users table must have isPremium column');
  assert.ok('markupFixedVnd' in supplierSources, 'supplierSources must have markupFixedVnd column');
  assert.ok('supplierProductUrl' in products, 'products must have supplierProductUrl column');
  assert.ok('upstreamCost' in products, 'products must have upstreamCost column');
  assert.ok('maxUpstreamCost' in products, 'products must have maxUpstreamCost column');
  assert.ok('costSyncedAt' in products, 'products must have costSyncedAt column');
  assert.ok('autoPricing' in products, 'products must have autoPricing column');
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

test('paymentTransactions table has required columns', () => {
  assert.ok('id' in paymentTransactions, 'must have id');
  assert.ok('walletId' in paymentTransactions, 'must have walletId');
  assert.ok('gateway' in paymentTransactions, 'must have gateway');
  assert.ok('externalTransactionId' in paymentTransactions, 'must have externalTransactionId');
  assert.ok('amount' in paymentTransactions, 'must have amount');
  assert.ok('status' in paymentTransactions, 'must have status');
  assert.ok('transferContent' in paymentTransactions, 'must have transferContent');
  assert.ok('bankName' in paymentTransactions, 'must have bankName');
  assert.ok('bankBin' in paymentTransactions, 'must have bankBin');
  assert.ok('bankAccount' in paymentTransactions, 'must have bankAccount');
  assert.ok('qrPayload' in paymentTransactions, 'must have qrPayload');
  assert.ok('expiresAt' in paymentTransactions, 'must have expiresAt');
  assert.ok('metadata' in paymentTransactions, 'must have metadata');
  assert.ok('createdAt' in paymentTransactions, 'must have createdAt');
  assert.ok('updatedAt' in paymentTransactions, 'must have updatedAt');
});
