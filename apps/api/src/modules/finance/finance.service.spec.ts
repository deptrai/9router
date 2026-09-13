import { test } from 'node:test';
import assert from 'node:assert';
import { FinanceService } from './finance.service';
import { LedgerType } from '@repo/shared-types';

/**
 * Extract raw SQL string from drizzle sql`` template wrapper,
 * including table and column identifiers.
 */
function sqlToString(query: any): string {
  if (typeof query === 'string') return query;
  if (query?.sql && typeof query.sql === 'string') return query.sql;
  if (query?.queryChunks && Array.isArray(query.queryChunks)) {
    const parts: string[] = [];
    for (const c of query.queryChunks) {
      if (typeof c === 'string') parts.push(c);
      else if (Array.isArray(c?.value)) parts.push(c.value.join(''));
      else if (typeof c?.value === 'string') parts.push(c.value);
      else if (c?.name) parts.push(c.name);
      else if (c?.[Symbol.for('drizzle:Name')]) parts.push(c[Symbol.for('drizzle:Name')]);
      else if (c?.table?.[Symbol.for('drizzle:Name')]) parts.push(c.table[Symbol.for('drizzle:Name')]);
    }
    return parts.join(' ');
  }
  return String(query);
}

test('[P0] FinanceService.getSummary computes reconciledDelta correctly when balanced', async () => {
  const service = new FinanceService();

  const fakeClient: any = {
    execute: async (query: any) => {
      const s = sqlToString(query);
      if (s.includes('TOPUP_VIETQR') || s.includes('TOPUP_CRYPTO')) return { rows: [{ total: '1000000.00' }] };
      if (s.includes('STORE_PURCHASE')) return { rows: [{ total: '500000.00' }] };
      if (s.includes('PURCHASE_REFUND')) return { rows: [{ total: '100000.00' }] };
      if (s.includes('wallets')) return { rows: [{ total: '600000.00' }] };
      return { rows: [] };
    },
    select: () => ({ from: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
  };

  const result = await service.getSummary(undefined, undefined, fakeClient);
  assert.strictEqual(result.isReconciled, true);
  assert.strictEqual(result.reconciledDelta, '0.00');
  assert.strictEqual(result.totalDepositsVnd, '1000000.00');
  assert.strictEqual(result.anomalousTransactions.length, 0);
});

test('[P0] FinanceService.getSummary flags anomalous when delta != 0', async () => {
  const service = new FinanceService();

  const fakeClient: any = {
    execute: async (query: any) => {
      const s = sqlToString(query);
      if (s.includes('TOPUP_VIETQR') || s.includes('TOPUP_CRYPTO')) return { rows: [{ total: '1000000.00' }] };
      if (s.includes('STORE_PURCHASE')) return { rows: [{ total: '500000.00' }] };
      if (s.includes('PURCHASE_REFUND')) return { rows: [{ total: '100000.00' }] };
      if (s.includes('wallets')) return { rows: [{ total: '500000.00' }] };
      return { rows: [] };
    },
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: () =>
            Promise.resolve([
              {
                id: 'ledger-1',
                walletId: 'wallet-1',
                type: LedgerType.STORE_PURCHASE,
                amount: '-100000.00',
                balanceBefore: '600000.00',
                balanceAfter: '500000.00',
                referenceId: 'order-1',
                idempotencyKey: 'key-1',
                metadata: null,
                createdAt: new Date('2026-09-13'),
              },
            ]),
        }),
      }),
    }),
  };

  const result = await service.getSummary(undefined, undefined, fakeClient);
  assert.strictEqual(result.isReconciled, false);
  assert.strictEqual(result.reconciledDelta, '100000.00');
  assert.strictEqual(result.anomalousTransactions.length, 1);
});

test('[P0] FinanceService.getRevenueMetrics returns zero-filled buckets for empty range', async () => {
  const service = new FinanceService();

  const fakeClient: any = {
    execute: async () => ({ rows: [] }),
    select: () => ({ from: () => ({}) }),
  };

  const from = new Date('2026-09-01T00:00:00Z');
  const to = new Date('2026-09-07T00:00:00Z');
  const metrics = await service.getRevenueMetrics('daily', from, to, fakeClient);
  assert.strictEqual(metrics.length, 7);
  for (const m of metrics) {
    assert.strictEqual(m.revenueVnd, '0.00');
    assert.strictEqual(m.costVnd, '0.00');
    assert.strictEqual(m.profitVnd, '0.00');
    assert.strictEqual(m.orderCount, 0);
  }
});

test('[P0] FinanceService.getRevenueMetrics merges revenue/cost/orders per bucket', async () => {
  const service = new FinanceService();

  const fakeClient: any = {
    execute: async (query: any) => {
      const s = sqlToString(query);
      if (s.includes('STORE_PURCHASE') && s.includes('amount')) {
        return {
          rows: [
            { bucket: new Date('2026-09-10T00:00:00Z'), revenue: '500000.00', cnt: '2' },
            { bucket: new Date('2026-09-11T00:00:00Z'), revenue: '300000.00', cnt: '1' },
          ],
        };
      }
      if (s.includes('cost') && s.includes('supplier_orders')) {
        return {
          rows: [{ bucket: new Date('2026-09-10T00:00:00Z'), cost: '200000.00' }],
        };
      }
      if (s.includes('COUNT') && s.includes('orders')) {
        return {
          rows: [
            { bucket: new Date('2026-09-10T00:00:00Z'), cnt: '5' },
            { bucket: new Date('2026-09-11T00:00:00Z'), cnt: '3' },
          ],
        };
      }
      return { rows: [] };
    },
    select: () => ({ from: () => ({}) }),
  };

  const from = new Date('2026-09-10T00:00:00Z');
  const to = new Date('2026-09-11T00:00:00Z');
  const metrics = await service.getRevenueMetrics('daily', from, to, fakeClient);
  assert.strictEqual(metrics.length, 2);
  assert.strictEqual(metrics[0].revenueVnd, '500000.00');
  assert.strictEqual(metrics[0].costVnd, '200000.00');
  assert.strictEqual(metrics[0].profitVnd, '300000.00');
  assert.strictEqual(metrics[0].orderCount, 5);
  assert.strictEqual(metrics[1].revenueVnd, '300000.00');
  assert.strictEqual(metrics[1].costVnd, '0.00');
  assert.strictEqual(metrics[1].profitVnd, '300000.00');
  assert.strictEqual(metrics[1].orderCount, 3);
});

test('[P1] FinanceService.getLedgerIntegrity detects wallet/ledger mismatch', async () => {
  const service = new FinanceService();

  const fakeClient: any = {
    execute: async (query: any) => {
      const s = sqlToString(query);
      if (s.includes('wallets') && s.includes('ledgerSum')) {
        return {
          rows: [
            { walletId: 'w-1', balance: '500000.00', ledgerSum: '400000.00' },
            { walletId: 'w-2', balance: '300000.00', ledgerSum: '300000.00' },
          ],
        };
      }
      return { rows: [] };
    },
    select: () => ({ from: () => ({}) }),
  };

  const result = await service.getLedgerIntegrity(fakeClient);
  assert.strictEqual(result.isClean, false);
  const walletViolation = result.violations.find((v) => v.rule === 'WALLET_LEDGER_MISMATCH');
  assert.ok(walletViolation, 'expected WALLET_LEDGER_MISMATCH violation');
  assert.strictEqual(walletViolation.offendingId, 'w-1');
  assert.strictEqual(walletViolation.severity, 'high');
});

test('[P1] FinanceService.getLedgerIntegrity returns isClean=true when no violations', async () => {
  const service = new FinanceService();

  const fakeClient: any = {
    execute: async () => ({ rows: [] }),
    select: () => ({ from: () => ({}) }),
  };

  const result = await service.getLedgerIntegrity(fakeClient);
  assert.strictEqual(result.isClean, true);
  assert.strictEqual(result.violations.length, 0);
});
