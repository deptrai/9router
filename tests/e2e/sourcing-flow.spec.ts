import { test, expect, Page } from '@playwright/test';

/**
 * E2E User Journey Test Suite for Story 4.3:
 * External Supplier Sourcing Worker & Telegram Mini App User Journey
 */

async function mockTelegramWebApp(page: Page) {
  await page.addInitScript(() => {
    (window as any).Telegram = {
      WebApp: {
        ready: () => {},
        expand: () => {},
        initData: 'query_id=test_query_id&user=%7B%22id%22%3A123456%2C%22first_name%22%3A%22Alex%22%7D',
        initDataUnsafe: {
          user: {
            id: 123456,
            first_name: 'Alex',
            username: 'alex_test',
          },
        },
        HapticFeedback: {
          impactOccurred: () => {},
          notificationOccurred: () => {},
          selectionChanged: () => {},
        },
      },
    };
  });
}

const mockExternalProduct = {
  id: 'prod-chatgpt-plus-ext',
  title: 'ChatGPT Plus 1 Tháng (Nguồn ngoài)',
  description: 'Tài khoản ChatGPT Plus kích hoạt qua nhà cung cấp tự động',
  price: '150000',
  category: 'AI Tools',
  stockStatus: 'IN_STOCK',
  sourcingMode: 'EXTERNAL',
  imageUrl: '',
};

const mockWallet = {
  ok: true,
  wallet: {
    id: 'wallet-test-01',
    balance: '500000',
    currency: 'VND',
  },
};

const mockSourcingOrder = {
  id: 'ord-sourcing-7890abcd',
  productId: 'prod-chatgpt-plus-ext',
  productTitle: 'ChatGPT Plus 1 Tháng (Nguồn ngoài)',
  price: '150000',
  status: 'SOURCING',
  createdAt: new Date().toISOString(),
  deliveredCredential: null,
};

const mockFulfilledOrder = {
  ...mockSourcingOrder,
  status: 'FULFILLED',
  deliveredCredential: 'gpt-upstream-auto-user@external.com:SecureKey!2026',
};

test.describe('Story 4.3: External Supplier Sourcing User Journey', () => {
  const miniAppUrl = process.env.MINI_APP_URL || 'http://localhost:3000';

  test.beforeEach(async ({ page }) => {
    await mockTelegramWebApp(page);
  });

  test('[P0] should complete full journey: catalog -> buy external product -> sourcing modal -> order fulfilled in history', async ({ page }) => {
    let orderFulfilledState = false;

    await page.route('**/api/wallets/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockWallet),
      });
    });

    await page.route('**/api/products', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          products: [mockExternalProduct],
        }),
      });
    });

    await page.route('**/api/orders/checkout', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          order: mockSourcingOrder,
        }),
      });
    });

    await page.route('**/api/orders', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(orderFulfilledState ? [mockFulfilledOrder] : [mockSourcingOrder]),
      });
    });

    const productsPromise = page.waitForResponse((res) => res.url().includes('/api/products') && res.status() === 200);
    await page.goto(miniAppUrl);
    await productsPromise;

    await expect(page.getByText('ChatGPT Plus 1 Tháng (Nguồn ngoài)')).toBeVisible();
    await expect(page.getByText('Còn hàng')).toBeVisible();

    const buyButton = page.getByRole('button', { name: 'Mua ngay' });
    await expect(buyButton).toBeVisible();
    await buyButton.click();

    await expect(page.getByRole('heading', { name: 'Xác nhận mua hàng' })).toBeVisible();
    await expect(page.getByText('Số dư ví')).toBeVisible();

    const checkoutPromise = page.waitForResponse((res) => res.url().includes('/api/orders/checkout') && res.status() === 200);
    const confirmButton = page.getByRole('button', { name: 'Xác nhận' });
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();
    await checkoutPromise;

    await expect(page.getByRole('heading', { name: 'Đơn hàng đang xử lý' })).toBeVisible();
    await expect(page.getByText(/Hệ thống đang lấy hàng từ nhà cung cấp/)).toBeVisible();

    const ordersPromise = page.waitForResponse((res) => res.url().includes('/api/orders') && res.status() === 200);
    const viewOrdersLink = page.getByRole('link', { name: 'Xem đơn hàng →' });
    await expect(viewOrdersLink).toBeVisible();
    await viewOrdersLink.click();
    await ordersPromise;

    await expect(page).toHaveURL(/.*\/orders/);
    await expect(page.getByRole('heading', { name: 'Đơn hàng của tôi' })).toBeVisible();
    await expect(page.getByText('SOURCING')).toBeVisible();
    await expect(page.getByText('Đang lấy hàng từ nhà cung cấp ngoài…')).toBeVisible();

    orderFulfilledState = true;
    await page.reload();

    await expect(page.getByText('FULFILLED')).toBeVisible();
    await expect(page.getByText('gpt-upstream-auto-user@external.com:SecureKey!2026')).toBeVisible();
    const copyButton = page.getByRole('button', { name: 'Sao chép' });
    await expect(copyButton).toBeVisible();
    await copyButton.click();
    await expect(page.getByRole('button', { name: '✓ Đã copy' })).toBeVisible();
  });

  test('[P1] should handle external sourcing unavailable (503) without deducting wallet balance', async ({ page }) => {
    await page.route('**/api/wallets/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockWallet),
      });
    });

    await page.route('**/api/products', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          products: [mockExternalProduct],
        }),
      });
    });

    await page.route('**/api/orders/checkout', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 503,
          errorCode: 'SOURCING_UNAVAILABLE',
          message: 'Sourcing queue is not available',
        }),
      });
    });

    await page.goto(miniAppUrl);
    await page.getByRole('button', { name: 'Mua ngay' }).click();
    await expect(page.getByRole('heading', { name: 'Xác nhận mua hàng' })).toBeVisible();

    const errorResponsePromise = page.waitForResponse((res) => res.url().includes('/api/orders/checkout') && res.status() === 503);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await errorResponsePromise;

    await expect(
      page.getByText('Hệ thống nguồn hàng tạm gián đoạn — bạn không bị trừ tiền. Vui lòng thử lại sau.')
    ).toBeVisible();

    const cancelButton = page.getByRole('button', { name: 'Huỷ' });
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();
    await expect(page.getByRole('heading', { name: 'Xác nhận mua hàng' })).not.toBeVisible();
  });

  test('[P1] should prevent duplicate purchases when external sourcing order is already in progress', async ({ page }) => {
    await page.route('**/api/wallets/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockWallet),
      });
    });

    await page.route('**/api/products', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          products: [mockExternalProduct],
        }),
      });
    });

    await page.route('**/api/orders/checkout', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 409,
          errorCode: 'ORDER_IN_PROGRESS',
          message: 'An order for this product is already in progress',
        }),
      });
    });

    await page.goto(miniAppUrl);
    await page.getByRole('button', { name: 'Mua ngay' }).click();
    await expect(page.getByRole('heading', { name: 'Xác nhận mua hàng' })).toBeVisible();

    const conflictPromise = page.waitForResponse((res) => res.url().includes('/api/orders/checkout') && res.status() === 409);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await conflictPromise;

    await expect(
      page.getByText('Bạn đang có đơn hàng đang xử lý cho sản phẩm này. Vui lòng chờ hoàn tất.')
    ).toBeVisible();

    await page.getByRole('button', { name: 'Huỷ' }).click();
    await expect(page.getByRole('heading', { name: 'Xác nhận mua hàng' })).not.toBeVisible();
  });

  test('[P2] should display order details and refunded status when scraper worker fails to acquire external key', async ({ page }) => {
    const mockRefundedOrder = {
      ...mockSourcingOrder,
      id: 'ord-refund-99887766',
      status: 'REFUNDED',
      deliveredCredential: null,
    };

    await page.route('**/api/orders', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([mockRefundedOrder]),
      });
    });

    const ordersPromise = page.waitForResponse((res) => res.url().includes('/api/orders') && res.status() === 200);
    await page.goto(`${miniAppUrl}/orders`);
    await ordersPromise;

    await expect(page.getByRole('heading', { name: 'Đơn hàng của tôi' })).toBeVisible();
    await expect(page.getByText('ChatGPT Plus 1 Tháng (Nguồn ngoài)')).toBeVisible();
    await expect(page.getByText('#ord-refu')).toBeVisible();

    await expect(page.getByText('REFUNDED')).toBeVisible();
    await expect(page.getByText('Credential')).not.toBeVisible();
  });
});
