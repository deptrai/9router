import { test, expect } from '@playwright/test';

const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:3200';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

test.describe('Epic 4 Retro: Admin Ops Dashboard E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => {
      window.sessionStorage.setItem('admin_api_key', key);
    }, TEST_ADMIN_KEY);
  });

  test('[P0] Ops page renders KPI cards, supplier table, and failed-jobs table', async ({ page }) => {
    await page.route('**/api/admin/ops/metrics*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          metrics: {
            timeoutRatePct: 12.5,
            sweeperRescueCount: 3,
            avgSourcingLatencyMs: 4200,
            totalAttempts: 16,
            failedJobCount: 2,
            perSupplier: [
              {
                supplierSourceId: 'sup-uuid-1',
                supplierName: 'Supplier Alpha',
                successCount: 8,
                failCount: 1,
                avgLatencyMs: 3500,
                timeoutCount: 1,
              },
              {
                supplierSourceId: null,
                supplierName: 'Chưa xác định',
                successCount: 2,
                failCount: 1,
                avgLatencyMs: null,
                timeoutCount: 1,
              },
            ],
          },
        }),
      });
    });

    await page.route('**/api/admin/ops/failed-jobs*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          jobs: [
            {
              jobId: 'job-uuid-aaaa1111',
              orderId: 'order-uuid-bbbb2222',
              productId: 'prod-uuid-1',
              supplierSourceId: 'sup-uuid-1',
              failedReason: 'RETRY_EXHAUSTED:Purchase timed out after 45000ms',
              attemptsMade: 3,
              failedAt: '2026-09-13T08:00:00.000Z',
            },
            {
              jobId: 'job-uuid-cccc3333',
              orderId: 'order-uuid-dddd4444',
              productId: 'prod-uuid-2',
              supplierSourceId: 'sup-uuid-2',
              failedReason: 'SUPPLIER_INVALID',
              attemptsMade: 1,
              failedAt: '2026-09-13T07:30:00.000Z',
            },
          ],
        }),
      });
    });

    await page.goto(`${ADMIN_URL}/ops`);

    // Page title
    await expect(page.getByRole('heading', { name: 'Giám sát Vận hành' })).toBeVisible();

    // KPI cards
    await expect(page.getByText('Tỷ lệ Timeout')).toBeVisible();
    await expect(page.getByText('12.5%')).toBeVisible();
    await expect(page.getByText('Sweeper giải cứu')).toBeVisible();
    await expect(page.getByText('3', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Latency trung bình')).toBeVisible();
    await expect(page.getByText('4.2s')).toBeVisible();
    await expect(page.getByText('Job thất bại')).toBeVisible();

    // Supplier table
    await expect(page.getByText('Thống kê theo Nhà cung cấp')).toBeVisible();
    await expect(page.getByText('Supplier Alpha')).toBeVisible();
    await expect(page.getByText('Chưa xác định')).toBeVisible();

    // Failed jobs table
    await expect(page.getByText('Dead-letter Queue — sourcing-queue')).toBeVisible();
    await expect(page.getByText('RETRY_EXHAUSTED:Purchase timed out after 45000ms')).toBeVisible();
    await expect(page.getByText('SUPPLIER_INVALID')).toBeVisible();

    // Retry buttons
    const retryButtons = page.getByRole('button', { name: 'Retry' });
    await expect(retryButtons).toHaveCount(2);
  });

  test('[P0] Retry button calls POST and shows success toast', async ({ page }) => {
    let retriedJobId = '';

    await page.route('**/api/admin/ops/metrics*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          metrics: {
            timeoutRatePct: 0,
            sweeperRescueCount: 0,
            avgSourcingLatencyMs: null,
            totalAttempts: 0,
            failedJobCount: 1,
            perSupplier: [],
          },
        }),
      });
    });

    await page.route('**/api/admin/ops/failed-jobs*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          jobs: [
            {
              jobId: 'job-to-retry-1234',
              orderId: 'order-abc-1234',
              productId: 'prod-1',
              supplierSourceId: 'sup-1',
              failedReason: 'RETRY_EXHAUSTED:Network error',
              attemptsMade: 3,
              failedAt: '2026-09-13T08:00:00.000Z',
            },
          ],
        }),
      });
    });

    await page.route('**/api/admin/ops/failed-jobs/*/retry', async (route) => {
      const url = route.request().url();
      const match = url.match(/failed-jobs\/([^/]+)\/retry/);
      retriedJobId = match?.[1] ?? '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, jobId: retriedJobId, state: 'waiting' }),
      });
    });

    await page.goto(`${ADMIN_URL}/ops`);
    await page.getByRole('button', { name: 'Retry' }).first().click();

    await page.waitForTimeout(500);
    expect(retriedJobId).toBe('job-to-retry-1234');
    await expect(page.getByText('Đã đưa job', { exact: false })).toBeVisible();
  });

  test('[P1] Ops page shows empty states when no data', async ({ page }) => {
    await page.route('**/api/admin/ops/metrics*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          metrics: {
            timeoutRatePct: 0,
            sweeperRescueCount: 0,
            avgSourcingLatencyMs: null,
            totalAttempts: 0,
            failedJobCount: 0,
            perSupplier: [],
          },
        }),
      });
    });

    await page.route('**/api/admin/ops/failed-jobs*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, jobs: [] }),
      });
    });

    await page.goto(`${ADMIN_URL}/ops`);

    await expect(page.getByText('Chưa có dữ liệu sourcing trong 24h qua')).toBeVisible();
    await expect(page.getByText('Không có job thất bại — hệ thống sạch')).toBeVisible();
    await expect(page.getByText('0.0%')).toBeVisible();
  });

  test('[P1] Ops page handles API error gracefully', async ({ page }) => {
    await page.route('**/api/admin/ops/metrics*', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 'SOURCING_UNAVAILABLE', message: 'Sourcing queue is not available' }),
      });
    });
    await page.route('**/api/admin/ops/failed-jobs*', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 'SOURCING_UNAVAILABLE', message: 'Sourcing queue is not available' }),
      });
    });

    await page.goto(`${ADMIN_URL}/ops`);

    // Toast error should appear
    await page.waitForTimeout(500);
    await expect(page.getByRole('heading', { name: 'Giám sát Vận hành' })).toBeVisible();
  });
});
