import { test } from 'node:test';
import assert from 'node:assert';
import { AdminFinanceController } from './admin-finance.controller';
import { BadRequestException } from '@nestjs/common';

test('[P0] AdminFinanceController has AdminRoleGuard applied at class level', () => {
  const guards = Reflect.getMetadata('__guards__', AdminFinanceController);
  assert.ok(guards, 'Guards should be defined');
  assert.strictEqual(guards.length, 1);
  assert.strictEqual(guards[0].name, 'AdminRoleGuard');
});

test('[P0] AdminFinanceController.getSummary delegates to service with parsed dates', async () => {
  let capturedFrom: Date | undefined;
  let capturedTo: Date | undefined;

  const mockService = {
    getSummary: async (from?: Date, to?: Date) => {
      capturedFrom = from;
      capturedTo = to;
      return {
        totalDepositsVnd: '1000.00',
        totalPurchasesVnd: '500.00',
        totalRefundsVnd: '100.00',
        totalWalletLiabilitiesVnd: '600.00',
        reconciledDelta: '0.00',
        isReconciled: true,
        anomalousTransactions: [],
      };
    },
  };

  const controller = new AdminFinanceController(mockService as any);
  const result = await controller.getSummary('2026-09-01', '2026-09-13', { user: { id: 42 } });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.isReconciled, true);
  assert.ok(capturedFrom instanceof Date);
  assert.ok(capturedTo instanceof Date);
  assert.strictEqual(capturedFrom!.toISOString(), '2026-09-01T00:00:00.000Z');
});

test('[P1] AdminFinanceController.getSummary rejects invalid date format', async () => {
  const controller = new AdminFinanceController({} as any);
  await assert.rejects(
    () => controller.getSummary('not-a-date', undefined, { user: { id: 1 } }),
    BadRequestException,
  );
});

test('[P1] AdminFinanceController.getSummary rejects from > to', async () => {
  const controller = new AdminFinanceController({} as any);
  await assert.rejects(
    () => controller.getSummary('2026-09-13', '2026-09-01', { user: { id: 1 } }),
    (err: any) => err.response?.errorCode === 'INVALID_DATE_RANGE' || err.message.includes('from'),
  );
});

test('[P0] AdminFinanceController.getRevenue validates granularity enum', async () => {
  const mockService = {
    getRevenueMetrics: async () => [],
  };
  const controller = new AdminFinanceController(mockService as any);

  // Valid granularities pass
  for (const g of ['daily', 'weekly', 'monthly']) {
    const res = await controller.getRevenue(g, undefined, undefined, { user: { id: 1 } });
    assert.strictEqual(res.ok, true);
  }

  // Invalid granularity rejects
  await assert.rejects(
    () => controller.getRevenue('hourly', undefined, undefined, { user: { id: 1 } }),
    (err: any) => err.response?.errorCode === 'INVALID_GRANULARITY',
  );
});

test('[P0] AdminFinanceController.getLedgerIntegrity delegates and returns violations', async () => {
  const mockService = {
    getLedgerIntegrity: async () => ({
      isClean: false,
      violations: [
        {
          rule: 'WALLET_LEDGER_MISMATCH',
          severity: 'high' as const,
          offendingId: 'w-1',
          detail: 'wallet balance 500 != ledger sum 400',
        },
      ],
    }),
  };
  const controller = new AdminFinanceController(mockService as any);
  const res = await controller.getLedgerIntegrity({ user: { id: 1 } });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.integrity.isClean, false);
  assert.strictEqual(res.integrity.violations.length, 1);
  assert.strictEqual(res.integrity.violations[0].rule, 'WALLET_LEDGER_MISMATCH');
});
