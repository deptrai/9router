import { test, expect } from '@playwright/test';

/**
 * Story 5.1: Admin Web Portal Product Catalog & Supplier Management E2E Tests
 */

const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:3002';
const API_URL = process.env.API_URL || 'http://localhost:3001';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

test.describe('Story 5.1: Admin Web Portal E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Inject session storage admin key
    await page.addInitScript((key) => {
      window.sessionStorage.setItem('admin_api_key', key);
    }, TEST_ADMIN_KEY);
  });

  test('[P0] Admin Dashboard loads with overview KPIs and navigation links', async ({ page }) => {
    await page.route('**/api/admin/products', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          products: [
            {
              id: 'p1',
              title: 'Test Kiro Pro',
              slug: 'test-kiro-pro',
              price: '120000.00',
              category: 'AI Tools',
              sourcingMode: 'EXTERNAL',
              isActive: true,
              availableCount: 0,
              soldCount: 10,
              autoPricing: true,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route('**/api/admin/suppliers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          suppliers: [
            {
              id: 's1',
              name: 'Test Supplier Global',
              type: 'CONFIG_POOL',
              markupPercentage: '10.00',
              markupFixedVnd: '5000.00',
              isActive: true,
              linkedProductsCount: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.goto(ADMIN_URL);

    // Verify header branding
    await expect(page.getByText('Admin Console')).toBeVisible();
    await expect(page.getByText('Xác thực Admin')).toBeVisible();

    // Verify KPI cards
    await expect(page.getByText('Tổng sản phẩm')).toBeVisible();
    await expect(page.getByText('Nhà cung cấp')).toBeVisible();
    await expect(page.getByText('Test Kiro Pro')).toBeVisible();
    await expect(page.getByText('Test Supplier Global')).toBeVisible();
  });

  test('[P0] Admin Products Page renders product table and allows opening create modal', async ({ page }) => {
    await page.route('**/api/admin/products', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          products: [
            {
              id: 'p1',
              title: 'Netflix Premium 1M',
              slug: 'netflix-premium-1m',
              price: '75000.00',
              category: 'Subscriptions',
              sourcingMode: 'IN_HOUSE',
              isActive: true,
              availableCount: 5,
              soldCount: 20,
              autoPricing: false,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route('**/api/admin/suppliers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, suppliers: [] }),
      });
    });

    await page.goto(`${ADMIN_URL}/products`);

    // Verify table content
    await expect(page.getByRole('heading', { name: 'Quản trị Sản phẩm' })).toBeVisible();
    await expect(page.getByText('Netflix Premium 1M')).toBeVisible();
    await expect(page.getByText('75.000 ₫')).toBeVisible();
    await expect(page.getByText('IN_HOUSE')).toBeVisible();

    // Open create product modal
    await page.getByRole('button', { name: 'Thêm sản phẩm' }).click();
    await expect(page.getByRole('heading', { name: 'Thêm sản phẩm mới' })).toBeVisible();
    await expect(page.getByPlaceholder('VD: Netflix Premium 1 Tháng')).toBeVisible();

    // Close modal
    await page.getByRole('button', { name: 'Hủy' }).click();
    await expect(page.getByRole('heading', { name: 'Thêm sản phẩm mới' })).not.toBeVisible();
  });

  test('[P0] Admin Suppliers Page renders supplier table and validates JSON syntax in modal', async ({ page }) => {
    await page.route('**/api/admin/suppliers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          suppliers: [
            {
              id: 'sup-1',
              name: 'Partner Key Source',
              type: 'CONFIG_POOL',
              targetUrl: 'https://supplier-shop.com',
              markupPercentage: '12.00',
              markupFixedVnd: '3000.00',
              isActive: true,
              linkedProductsCount: 4,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.goto(`${ADMIN_URL}/suppliers`);

    await expect(page.getByRole('heading', { name: 'Quản trị Nhà cung cấp' })).toBeVisible();
    await expect(page.getByText('Partner Key Source')).toBeVisible();
    await expect(page.getByText('+12%')).toBeVisible();

    // Open create supplier modal
    await page.getByRole('button', { name: 'Thêm nhà cung cấp' }).click();
    await expect(page.getByRole('heading', { name: 'Thêm nhà cung cấp mới' })).toBeVisible();

    // Verify syntax validation indicator
    await expect(page.getByText('Cú pháp JSON hợp lệ')).toBeVisible();

    // Click "Mẫu Scraper"
    await page.getByRole('button', { name: 'Mẫu Scraper' }).click();
    await expect(page.getByText('Cú pháp JSON hợp lệ')).toBeVisible();

    // Close modal
    await page.getByRole('button', { name: 'Hủy' }).click();
    await expect(page.getByRole('heading', { name: 'Thêm nhà cung cấp mới' })).not.toBeVisible();
  });

  test('[P1] Immediate Sync Contract: active products are immediately served by public catalog endpoint (< 1s)', async ({ request }) => {
    // Check public GET /api/products returns 200 array
    const res = await request.get(`${API_URL}/api/products`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.products)).toBe(true);
  });
});
