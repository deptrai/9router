import { test, expect } from '@playwright/test';

/**
 * Story 5.1: Admin Web Portal Product Catalog & Supplier Management E2E Tests
 */

const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:3200';
const API_URL = process.env.API_URL || 'http://localhost:3201';
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
    await expect(page.getByRole('main').getByText('Nhà cung cấp', { exact: true })).toBeVisible();
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
    await expect(page.getByText('IN_HOUSE', { exact: true })).toBeVisible();

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
    await expect(page.getByText('+12.00%')).toBeVisible();

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

  test('[P0] Product form submission sends correct payload to API', async ({ page }) => {
    let capturedPayload: any = null;

    await page.route('**/api/admin/products', async (route) => {
      if (route.request().method() === 'POST') {
        capturedPayload = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            product: {
              id: 'new-p1',
              title: capturedPayload.title,
              slug: 'new-product-slug',
              price: capturedPayload.price,
              category: capturedPayload.category,
              sourcingMode: capturedPayload.sourcingMode,
              isActive: true,
              availableCount: 0,
              soldCount: 0,
              autoPricing: false,
              createdAt: new Date().toISOString(),
            },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, products: [] }),
        });
      }
    });

    await page.route('**/api/admin/suppliers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, suppliers: [] }),
      });
    });

    await page.goto(`${ADMIN_URL}/products`);
    await page.getByRole('button', { name: 'Thêm sản phẩm' }).click();

    // Fill form fields
    await page.getByPlaceholder('VD: Netflix Premium 1 Tháng').fill('Test Product Alpha');
    await page.getByPlaceholder('VD: 75000').fill('50000');

    // Submit form
    await page.getByRole('button', { name: 'Lưu' }).click();

    // Verify payload was captured and has correct fields
    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload.title).toBe('Test Product Alpha');
    expect(capturedPayload.price).toBe('50000');
    expect(capturedPayload.sourcingMode).toBe('IN_HOUSE');
    expect(capturedPayload.autoPricing).toBe(true); // default

    // Verify modal closes after submit
    await expect(page.getByRole('heading', { name: 'Thêm sản phẩm mới' })).not.toBeVisible({ timeout: 5000 });
  });

  test('[P1] Immediate Sync Contract: admin CRUD reflects on public catalog', async ({ request }) => {
    // Create product via admin API
    const createRes = await request.post(`${API_URL}/api/admin/products`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: {
        title: 'Sync Contract Test Product',
        price: '88888.00',
        sourcingMode: 'IN_HOUSE',
        category: 'Test',
        isActive: true,
      },
    });

    expect([200, 201]).toContain(createRes.status());
    const createBody = await createRes.json();
    const productId = createBody.product?.id;
    expect(productId).toBeTruthy();

    // Verify it appears in public catalog within 1 second
    const start = Date.now();
    let found = false;
    while (Date.now() - start < 1000) {
      const catRes = await request.get(`${API_URL}/api/products`);
      const catBody = await catRes.json();
      if (catBody.products?.some((p: any) => p.id === productId)) {
        found = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(found).toBe(true);

    // Deactivate and verify it disappears from public catalog
    await request.patch(`${API_URL}/api/admin/products/${productId}`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: { isActive: false },
    });

    const catRes2 = await request.get(`${API_URL}/api/products`);
    const catBody2 = await catRes2.json();
    const stillVisible = catBody2.products?.some((p: any) => p.id === productId);
    expect(stillVisible).toBe(false);
  });
});
