import { test, expect } from '@playwright/test';

/**
 * Story 5.1 & 6.3: Admin Web Portal Supplier Source Management E2E Tests
 */

const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:3200';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

const mockSuppliers = [
  {
    id: 'sup-1',
    name: 'Main Config Pool Supplier',
    type: 'CONFIG_POOL',
    targetUrl: null,
    markupPercentage: '15.00',
    markupFixedVnd: '5000.00',
    isActive: true,
    lastSyncAt: new Date().toISOString(),
    linkedProductCount: 2,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'sup-2',
    name: 'Telegram Bot Auto Scraper',
    type: 'TELEGRAM_BOT',
    targetUrl: 'https://t.me/test_supplier_bot',
    markupPercentage: '20.00',
    markupFixedVnd: '10000.00',
    isActive: false,
    lastSyncAt: null,
    linkedProductCount: 0,
    createdAt: new Date().toISOString(),
  },
];

test.describe('Admin Supplier Management E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Inject session storage admin key
    await page.addInitScript((key) => {
      window.sessionStorage.setItem('admin_api_key', key);
    }, TEST_ADMIN_KEY);

    // Network-first route interception before navigation
    await page.route('**/api/admin/suppliers', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            suppliers: mockSuppliers,
          }),
        });
      } else {
        await route.continue();
      }
    });
  });

  test('[P0] Loads supplier management page with supplier table and statistics', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/suppliers`);

    await expect(page.getByRole('heading', { name: 'Nhà cung cấp' })).toBeVisible();
    await expect(page.getByText('Main Config Pool Supplier')).toBeVisible();
    await expect(page.getByText('Telegram Bot Auto Scraper')).toBeVisible();

    // Verify type tags
    await expect(page.getByText('CONFIG_POOL')).toBeVisible();
    await expect(page.getByText('TELEGRAM_BOT')).toBeVisible();

    // Verify markup columns
    await expect(page.getByText('15.00%')).toBeVisible();
  });

  test('[P0] Filters supplier list by search keyword', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/suppliers`);

    const searchInput = page.getByPlaceholder(/Tìm kiếm nhà cung cấp/i);
    await searchInput.fill('Config Pool');

    await expect(page.getByText('Main Config Pool Supplier')).toBeVisible();
    await expect(page.getByText('Telegram Bot Auto Scraper')).not.toBeVisible();
  });

  test('[P0] Opens creation modal and creates new supplier source', async ({ page }) => {
    await page.route('**/api/admin/suppliers', async (route) => {
      if (route.request().method() === 'POST') {
        const data = route.request().postDataJSON();
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            supplier: {
              id: 'sup-new',
              name: data.name,
              type: data.type,
              markupPercentage: data.markupPercentage,
              markupFixedVnd: data.markupFixedVnd,
              isActive: true,
              createdAt: new Date().toISOString(),
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto(`${ADMIN_URL}/suppliers`);

    // Click "Thêm nhà cung cấp" button
    await page.getByRole('button', { name: /Thêm nhà cung cấp/i }).click();

    // Verify modal header is visible
    await expect(page.getByText('Thêm nhà cung cấp mới')).toBeVisible();

    // Fill form fields via placeholder
    await page.getByPlaceholder(/Kho sỉ Digital Pro/i).fill('New API Partner');
    await page.getByPlaceholder('10.00').fill('18.5');
    await page.getByPlaceholder('5000.00').fill('4000');

    // Submit form
    await page.getByRole('button', { name: /Lưu nhà cung cấp/i }).click();

    // Modal header should close on success
    await expect(page.getByText('Thêm nhà cung cấp mới')).not.toBeVisible();
  });

  test('[P0] Toggles supplier active/inactive state', async ({ page }) => {
    let patchedStatus: boolean | null = null;
    await page.route('**/api/admin/suppliers/sup-1', async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();
        patchedStatus = body.isActive;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            supplier: { ...mockSuppliers[0], isActive: patchedStatus },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto(`${ADMIN_URL}/suppliers`);

    // Find active toggle button for first supplier (text 'Bật')
    const patchPromise = page.waitForRequest(
      (req) => req.url().includes('/api/admin/suppliers/sup-1') && req.method() === 'PATCH',
    );
    const activeToggle = page.getByRole('button', { name: 'Bật' }).first();
    await activeToggle.click();
    await patchPromise;

    expect(patchedStatus).toBe(false);
  });

  test('[P1] Triggers manual catalog sync and shows success feedback', async ({ page }) => {
    await page.route('**/api/admin/suppliers/*/sync', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          jobId: 'job-sync-12345',
          queuedAt: new Date().toISOString(),
        }),
      });
    });

    await page.goto(`${ADMIN_URL}/suppliers`);

    // Click sync icon button (title="Kích hoạt đồng bộ ngay")
    const syncButton = page.locator('button[title="Kích hoạt đồng bộ ngay"]').first();
    await syncButton.click();

    // Verify feedback toast is displayed
    await expect(page.getByText(/Đã kích hoạt đồng bộ/i)).toBeVisible();
  });
});
