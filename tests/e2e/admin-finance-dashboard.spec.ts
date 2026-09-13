import { test, expect } from '@playwright/test';

const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:3200';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

test.describe('Story 5.4: Admin Finance Dashboard E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => {
      window.sessionStorage.setItem('admin_api_key', key);
    }, TEST_ADMIN_KEY);
  });

  test('[P0] Finance page renders reconciliation banner, KPI cards, and revenue chart', async ({ page }) => {
    await page.route('**/api/admin/finance/summary*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          summary: {
            totalDepositsVnd: '1000000.00',
            totalPurchasesVnd: '400000.00',
            totalRefundsVnd: '100000.00',
            totalWalletLiabilitiesVnd: '700000.00',
            reconciledDelta: '0.00',
            isReconciled: true,
            anomalousTransactions: [],
          },
        }),
      });
    });

    await page.route('**/api/admin/finance/revenue*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          metrics: [
            {
              bucket: '2026-09-10T00:00:00.000Z',
              revenueVnd: '200000.00',
              costVnd: '100000.00',
              profitVnd: '100000.00',
              orderCount: 2,
            },
            {
              bucket: '2026-09-11T00:00:00.000Z',
              revenueVnd: '200000.00',
              costVnd: '100000.00',
              profitVnd: '100000.00',
              orderCount: 2,
            },
          ],
        }),
      });
    });

    await page.route('**/api/admin/finance/ledger-check*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          integrity: {
            violations: [],
            isClean: true,
          },
        }),
      });
    });

    await page.goto(`${ADMIN_URL}/finance`);

    await expect(page.getByRole('heading', { name: 'Báo cáo Tài chính & Đối soát' })).toBeVisible();
    await expect(page.getByText('✓ Đã đối soát chính xác')).toBeVisible();

    const grid = page.locator('.grid');
    await expect(grid.getByText('Tổng nạp')).toBeVisible();
    await expect(grid.getByText('Tổng mua')).toBeVisible();
    await expect(grid.getByText('Tổng hoàn')).toBeVisible();
    await expect(grid.getByText('Ví khách')).toBeVisible();
    await expect(grid.getByText('Độ lệch')).toBeVisible();

    await expect(page.getByText('1.000.000 ₫')).toBeVisible();
    await expect(page.getByText('400.000 ₫')).toBeVisible();
    await expect(page.getByText('700.000 ₫')).toBeVisible();

    await expect(page.locator('svg.w-full')).toBeVisible();

    let granularityRequested = '';
    await page.route('**/api/admin/finance/revenue?granularity=weekly', async (route) => {
      granularityRequested = 'weekly';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          metrics: [
            {
              bucket: '2026-09-07T00:00:00.000Z',
              revenueVnd: '400000.00',
              costVnd: '200000.00',
              profitVnd: '200000.00',
              orderCount: 4,
            },
          ],
        }),
      });
    });

    await page.getByRole('button', { name: 'Tuần' }).click();
    await page.waitForTimeout(300);
    expect(granularityRequested).toBe('weekly');
  });

  test('[P0] Finance page alerts on reconciliation mismatch and displays integrity violations', async ({ page }) => {
    await page.route('**/api/admin/finance/summary*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          summary: {
            totalDepositsVnd: '1000000.00',
            totalPurchasesVnd: '400000.00',
            totalRefundsVnd: '100000.00',
            totalWalletLiabilitiesVnd: '600000.00',
            reconciledDelta: '100000.00',
            isReconciled: false,
            anomalousTransactions: [
              {
                id: 'suspicious-tx-uuid-12345678',
                walletId: 'w-1',
                type: 'STORE_PURCHASE',
                amount: '-100000.00',
                balanceBefore: '700000.00',
                balanceAfter: '600000.00',
                referenceId: 'order-1',
                idempotencyKey: 'key-1',
                createdAt: new Date().toISOString(),
              },
            ],
          },
        }),
      });
    });

    await page.route('**/api/admin/finance/ledger-check*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          integrity: {
            isClean: false,
            violations: [
              {
                rule: 'WALLET_LEDGER_MISMATCH',
                severity: 'high',
                offendingId: 'w-1-uuid-abcdef',
                detail: 'wallet.balance=600000 but SUM(ledger)=700000 (diff=-100000)',
              },
            ],
          },
        }),
      });
    });

    await page.route('**/api/admin/finance/revenue*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, metrics: [] }),
      });
    });

    await page.goto(`${ADMIN_URL}/finance`);

    await expect(page.getByText('⚠ Phát hiện chênh lệch đối soát')).toBeVisible();
    await expect(page.getByText('Phát hiện 1 vi phạm toàn vẹn sổ cái')).toBeVisible();
    await expect(page.getByText('WALLET_LEDGER_MISMATCH')).toBeVisible();
    await expect(page.getByText('wallet.balance=600000 but SUM(ledger)=700000')).toBeVisible();
    await expect(page.getByText('Giao dịch gần đây cần kiểm tra')).toBeVisible();
    await expect(page.getByText('#suspicio')).toBeVisible();
  });
});
