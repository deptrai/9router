import { test, expect } from '@playwright/test';

/**
 * Story 5.3: Admin Web Portal Order Management & Manual Refund E2E Tests
 *
 * Covers:
 * - Navigation to /orders page
 * - Inspection of 4 KPI cards and filter tabs
 * - Table rendering with order information, status badges, and pricing
 * - Opening OrderDetailModal to inspect customer, product, and supplier logs
 * - Executing manual refund workflow with reason submission and toast confirmation
 */

const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:3200';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

test.describe('Story 5.3: Admin Order Management E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Inject session storage admin key
    await page.addInitScript((key) => {
      window.sessionStorage.setItem('admin_api_key', key);
    }, TEST_ADMIN_KEY);
  });

  test('[P0] Orders page renders 4 KPI cards, filters, and list of orders', async ({ page }) => {
    // Mock orders API
    await page.route('**/api/admin/orders*', async (route) => {
      if (route.request().url().includes('/api/admin/orders/')) {
        return route.continue();
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          orders: [
            {
              id: 'a1b2c3d4-e5f6-4000-8000-000000000001',
              userId: 'user-uuid-1',
              telegramId: 888999,
              username: 'alice_crypto',
              productId: 'prod-uuid-1',
              productTitle: 'ChatGPT Plus Monthly',
              price: '450000.00',
              status: 'FULFILLED',
              sourcingMode: 'IN_HOUSE',
              supplierName: null,
              createdAt: new Date().toISOString(),
              fulfilledAt: new Date().toISOString(),
            },
            {
              id: 'a1b2c3d4-e5f6-4000-8000-000000000002',
              userId: 'user-uuid-2',
              telegramId: 777666,
              username: 'bob_dev',
              productId: 'prod-uuid-2',
              productTitle: 'JetBrains All Products Pack',
              price: '300000.00',
              status: 'SOURCING',
              sourcingMode: 'EXTERNAL',
              supplierName: 'Partner Shop A',
              createdAt: new Date().toISOString(),
              fulfilledAt: null,
            },
          ],
          total: 2,
        }),
      });
    });

    await page.goto(`${ADMIN_URL}/orders`);

    // Verify Heading
    await expect(page.getByRole('heading', { name: 'Giám sát Đơn hàng & Đối soát' })).toBeVisible();

    // Verify KPI Cards via grid container
    const kpiGrid = page.locator('.grid');
    await expect(kpiGrid.getByText('Tổng đơn hàng')).toBeVisible();
    await expect(kpiGrid.getByText('Chờ mua ngoài')).toBeVisible();
    await expect(kpiGrid.getByText('Hoàn tất')).toBeVisible();
    await expect(kpiGrid.getByText('Đã hoàn tiền')).toBeVisible();

    // Verify Filter Buttons
    await expect(page.getByRole('button', { name: 'Chờ mua ngoài' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hoàn tất' })).toBeVisible();

    // Verify Orders in table
    const table = page.getByRole('table');
    await expect(table.getByText('#a1b2c3d4').first()).toBeVisible();
    await expect(table.getByText('@alice_crypto')).toBeVisible();
    await expect(table.getByText('ChatGPT Plus Monthly')).toBeVisible();
    await expect(table.getByText('450.000 ₫')).toBeVisible();
    await expect(table.getByText('@bob_dev')).toBeVisible();
    await expect(table.getByText('Partner Shop A')).toBeVisible();
  });

  test('[P0] Admin can open OrderDetailModal, view customer/product info and execute manual refund', async ({ page }) => {
    const targetOrderId = 'a1b2c3d4-e5f6-4000-8000-000000000001';

    // Mock orders list
    await page.route('**/api/admin/orders?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          orders: [
            {
              id: targetOrderId,
              userId: 'user-uuid-1',
              telegramId: 888999,
              username: 'alice_crypto',
              productId: 'prod-uuid-1',
              productTitle: 'ChatGPT Plus Monthly',
              price: '450000.00',
              status: 'FULFILLED',
              sourcingMode: 'IN_HOUSE',
              supplierName: null,
              createdAt: new Date().toISOString(),
              fulfilledAt: new Date().toISOString(),
            },
          ],
          total: 1,
        }),
      });
    });

    // Mock order detail API
    await page.route(`**/api/admin/orders/${targetOrderId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          order: {
            order: {
              id: targetOrderId,
              userId: 'user-uuid-1',
              productId: 'prod-uuid-1',
              status: 'FULFILLED',
              price: '450000.00',
              deliveredCredential: 'u***r@openai.com',
              createdAt: new Date().toISOString(),
              fulfilledAt: new Date().toISOString(),
            },
            customer: {
              id: 'user-uuid-1',
              telegramId: 888999,
              username: 'alice_crypto',
              firstName: 'Alice',
              lastName: 'Crypto',
              walletBalance: '150000.00',
            },
            product: {
              id: 'prod-uuid-1',
              title: 'ChatGPT Plus Monthly',
              slug: 'chatgpt-plus-monthly',
              price: '450000.00',
              sourcingMode: 'IN_HOUSE',
              category: 'AI Accounts',
            },
            supplierTraces: [],
            ledgerTransactions: [],
          },
        }),
      });
    });

    let refundCalled = false;
    // Mock refund API
    await page.route(`**/api/admin/orders/${targetOrderId}/refund`, async (route) => {
      const payload = route.request().postDataJSON();
      expect(payload.reason).toBe('Customer key activation failed');
      refundCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          refunded: true,
          orderId: targetOrderId,
          refundedAmount: '450000.00',
          refundedAt: new Date().toISOString(),
        }),
      });
    });

    await page.goto(`${ADMIN_URL}/orders`);

    // Click on row to open modal
    const detailBtn = page.getByRole('button', { name: 'Chi tiết' });
    await expect(detailBtn).toBeVisible();
    await detailBtn.click();

    // Verify modal elements inside modal overlay
    const modal = page.locator('.fixed');
    await expect(modal.getByRole('heading', { name: 'Chi tiết Đơn hàng' })).toBeVisible();
    await expect(modal.getByText('@alice_crypto')).toBeVisible();
    await expect(modal.getByText('u***r@openai.com')).toBeVisible();

    // Click "Hoàn tiền thủ công"
    const refundTriggerBtn = modal.getByRole('button', { name: 'Hoàn tiền thủ công' });
    await expect(refundTriggerBtn).toBeVisible();
    await refundTriggerBtn.click();

    // Fill refund reason
    const reasonTextarea = modal.locator('textarea');
    await expect(reasonTextarea).toBeVisible();
    await reasonTextarea.fill('Customer key activation failed');

    // Submit refund
    const confirmRefundBtn = modal.getByRole('button', { name: 'Xác nhận hoàn tiền' });
    await expect(confirmRefundBtn).toBeVisible();
    await confirmRefundBtn.click();

    // Verify submission
    await page.waitForTimeout(500);
    expect(refundCalled).toBe(true);
  });
});
