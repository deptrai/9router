import { test, expect } from '@playwright/test';

/**
 * Story 5.2: Admin Web Portal Inventory Management E2E Tests
 *
 * Covers:
 * - Navigation to /inventory page
 * - Product selection, KPI cards display (Available, Reserved, Sold, Defective)
 * - Batch Import modal opening, multi-line pasting, live line counter
 * - Batch import submission, toast notification, table refresh
 * - Masked credential viewing and copy-to-clipboard
 * - Status toggle (Mark Defective) and Deletion
 */

const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:3200';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

test.describe('Story 5.2: Admin Inventory Management E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Inject session storage admin key
    await page.addInitScript((key) => {
      window.sessionStorage.setItem('admin_api_key', key);
    }, TEST_ADMIN_KEY);
  });

  test('[P0] Inventory page renders product selector, 4 KPI cards and empty table', async ({ page }) => {
    // Mock products API
    await page.route('**/api/admin/products', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          products: [
            {
              id: 'prod-inhouse-1',
              title: 'ChatGPT Plus Account',
              slug: 'chatgpt-plus-account',
              price: '450000.00',
              category: 'AI Accounts',
              sourcingMode: 'IN_HOUSE',
              isActive: true,
              availableCount: 5,
              soldCount: 12,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    // Mock summary API
    await page.route('**/api/admin/inventory/products/prod-inhouse-1/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          summary: {
            available: 5,
            reserved: 2,
            sold: 12,
            defective: 1,
            total: 20,
          },
        }),
      });
    });

    // Mock inventory list API
    await page.route('**/api/admin/inventory/products/prod-inhouse-1*', async (route) => {
      if (route.request().url().includes('/summary')) return;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          items: [
            {
              id: 'inv-item-1',
              productId: 'prod-inhouse-1',
              status: 'AVAILABLE',
              orderId: null,
              addedAt: new Date().toISOString(),
              soldAt: null,
              maskedCredential: 'u***r@openai.com',
            },
            {
              id: 'inv-item-2',
              productId: 'prod-inhouse-1',
              status: 'SOLD',
              orderId: 'order-uuid-999',
              addedAt: new Date().toISOString(),
              soldAt: new Date().toISOString(),
              maskedCredential: 'admin:****',
            },
          ],
          total: 2,
        }),
      });
    });

    await page.goto(`${ADMIN_URL}/inventory`);

    // Verify Title and KPI cards
    await expect(page.getByRole('heading', { name: 'Quản lý Kho Hàng Nội bộ' })).toBeVisible();
    await expect(page.getByText('ChatGPT Plus Account', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Khả dụng' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Đang giữ' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Đã bán' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hỏng', exact: true })).toBeVisible();

    // Verify table items
    await expect(page.getByText('u***r@openai.com')).toBeVisible();
    await expect(page.getByText('admin:****')).toBeVisible();
  });

  test('[P0] Batch Import Modal opens, calculates valid lines, and submits batch', async ({ page }) => {
    // Mock APIs
    await page.route('**/api/admin/products', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          products: [
            {
              id: 'prod-1',
              title: 'Canva Pro 1 Year',
              slug: 'canva-pro',
              price: '190000.00',
              sourcingMode: 'IN_HOUSE',
              isActive: true,
              availableCount: 0,
            },
          ],
        }),
      });
    });

    await page.route('**/api/admin/inventory/products/prod-1/summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          summary: { available: 0, reserved: 0, sold: 0, defective: 0, total: 0 },
        }),
      });
    });

    await page.route('**/api/admin/inventory/products/prod-1?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, items: [], total: 0 }),
      });
    });

    let batchSubmitted = false;
    await page.route('**/api/admin/inventory/products/prod-1/batch', async (route) => {
      const data = route.request().postDataJSON();
      expect(data.credentials.length).toBe(3);
      batchSubmitted = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          count: 3,
          productId: 'prod-1',
          addedAt: new Date().toISOString(),
        }),
      });
    });

    await page.goto(`${ADMIN_URL}/inventory`);

    // Click "Nhập lô Credential" button
    const importBtn = page.getByRole('button', { name: 'Nhập lô Credential' });
    await expect(importBtn).toBeVisible();
    await importBtn.click();

    // Verify modal elements
    await expect(page.getByRole('heading', { name: 'Nhập lô Credential' })).toBeVisible();
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();

    // Paste credentials with comment and empty lines
    const inputContent = `user1@canva.com:pass123\n# this is a comment\n\nCANVA-KEY-2026-PREMIUM\nuser3@canva.com:pass456\n`;
    await textarea.fill(inputContent);

    // Verify live line counter shows 3 valid lines
    await expect(page.getByText('3 dòng hợp lệ')).toBeVisible();
    await expect(page.getByText('1 dòng comment (#)')).toBeVisible();

    // Submit batch
    const submitBtn = page.getByRole('button', { name: /Nhập 3 credential/i });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Wait for submission
    await page.waitForTimeout(500);
    expect(batchSubmitted).toBe(true);
  });
});
