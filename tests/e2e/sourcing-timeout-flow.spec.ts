import { test, expect, Page } from '@playwright/test';

/**
 * Story 4.4: Order Sourcing Timeout 60s & Auto-Refund User Journey (TDD Red Phase)
 *
 * Acceptance Criteria Covered:
 * - AC-1: 60s Sourcing Timeout Timer & Sweeper Backstop trigger auto-cancellation
 * - AC-2: Atomic cancellation & 100% refund balance restoration
 * - AC-5: Real-time OrderSuccessModal polling every 2.5s and transition to REFUNDED with
 *         "Nhà cung cấp tạm hết hàng, hệ thống đã hoàn trả 100% tiền vào ví"
 * - AC-5: Real-time OrderSuccessModal polling transition to FULFILLED if supplier completes before timeout
 * - AC-5: OrdersPage (/orders) displays REFUNDED status with amber warning badge and explanation:
 *         "Đã hoàn lại 100% tiền vào ví do nhà cung cấp không phản hồi hoặc quá 60s."
 * - AC-5: OrdersPage active polling auto-refreshes SOURCING orders to REFUNDED state without page reload
 * - AC-5: Modal polling cleanup on dismiss prevents leaking intervals
 *
 * NOTE: All tests are wrapped in test() for the TDD Red Phase.
 * Once developers implement Task 4 (OrderSuccessModal & OrdersPage real-time UX),
 * tests will be activated to drive Green phase verification.
 */

interface TelegramHapticLogs {
  notifications: string[];
  impacts: string[];
}

async function mockTelegramWebApp(page: Page) {
  await page.addInitScript(() => {
    (window as any).__telegramHapticLogs = {
      notifications: [] as string[],
      impacts: [] as string[],
    };
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
          impactOccurred: (style: string) => {
            (window as any).__telegramHapticLogs.impacts.push(style);
          },
          notificationOccurred: (type: string) => {
            (window as any).__telegramHapticLogs.notifications.push(type);
          },
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

const mockInitialWallet = {
  ok: true,
  wallet: {
    id: 'wallet-test-01',
    balance: '500000',
    currency: 'VND',
  },
};

const mockSourcingOrder = {
  id: 'ord-sourcing-timeout-1234',
  productId: 'prod-chatgpt-plus-ext',
  productTitle: 'ChatGPT Plus 1 Tháng (Nguồn ngoài)',
  price: '150000',
  status: 'SOURCING',
  createdAt: new Date().toISOString(),
  deliveredCredential: null,
};

const mockRefundedOrder = {
  ...mockSourcingOrder,
  status: 'REFUNDED',
  deliveredCredential: null,
};

const mockFulfilledOrder = {
  ...mockSourcingOrder,
  status: 'FULFILLED',
  deliveredCredential: 'gpt-upstream-auto-user@external.com:SecureKey!2026',
};

test.describe('Story 4.4: Order Sourcing Timeout 60s & Auto-Refund User Journey', () => {
  const miniAppUrl = process.env.MINI_APP_URL || 'http://localhost:3000';

  test.beforeEach(async ({ page }) => {
    await mockTelegramWebApp(page);
  });

  test('[P0] should automatically transition OrderSuccessModal from SOURCING to REFUNDED state on timeout', async ({ page }) => {
    // THIS TEST WILL FAIL IN RED PHASE - Polling and auto-transition to REFUNDED not implemented in OrderSuccessModal yet
    let pollCount = 0;

    await page.route('**/api/wallets/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockInitialWallet),
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
      pollCount++;
      // First poll returns SOURCING, subsequent polls return REFUNDED
      const currentOrder = pollCount <= 1 ? mockSourcingOrder : mockRefundedOrder;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([currentOrder]),
      });
    });

    // 1. Navigate to store catalog
    const productsPromise = page.waitForResponse((res) => res.url().includes('/api/products') && res.status() === 200);
    await page.goto(miniAppUrl);
    await productsPromise;

    // 2. Click Buy Now on external product
    const buyButton = page.getByRole('button', { name: 'Mua ngay' });
    await expect(buyButton).toBeVisible();
    await buyButton.click();

    // 3. Confirm checkout in modal
    await expect(page.getByRole('heading', { name: 'Xác nhận mua hàng' })).toBeVisible();
    const checkoutPromise = page.waitForResponse((res) => res.url().includes('/api/orders/checkout') && res.status() === 200);
    const confirmButton = page.getByRole('button', { name: 'Xác nhận' });
    await confirmButton.click();
    await checkoutPromise;

    // 4. Modal opens in SOURCING state
    await expect(page.getByRole('heading', { name: 'Đơn hàng đang xử lý' })).toBeVisible();
    await expect(page.getByText(/Đang lấy tài khoản từ đối tác/)).toBeVisible();

    // 5. Polling occurs: expect modal to automatically transition to REFUNDED state
    await expect(
      page.getByText('Nhà cung cấp tạm hết hàng, hệ thống đã hoàn trả 100% tiền vào ví')
    ).toBeVisible({ timeout: 10_000 });

    // 6. Verify credentials are not shown and copy button is absent
    await expect(page.getByRole('button', { name: 'Copy key' })).not.toBeVisible();
    await expect(page.getByText('Key / Tài khoản của bạn')).not.toBeVisible();

    // 7. Verify modal has completion dismiss button
    const doneButton = page.getByRole('button', { name: /Xong|Đóng/ });
    await expect(doneButton).toBeVisible();
    await doneButton.click();
    await expect(page.getByRole('heading', { name: 'Đơn hàng đang xử lý' })).not.toBeVisible();
  });

  test('[P0] should display REFUNDED order in /orders with amber status badge and timeout explanation notice', async ({ page }) => {
    // THIS TEST WILL FAIL IN RED PHASE - Amber warning badge and explanation notice not implemented in orders/page.tsx yet
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

    // 1. Verify Orders page header and product card
    await expect(page.getByRole('heading', { name: 'Đơn hàng của tôi' })).toBeVisible();
    await expect(page.getByText('ChatGPT Plus 1 Tháng (Nguồn ngoài)')).toBeVisible();
    await expect(page.getByText(/150.*VND/)).toBeVisible();

    // 2. Verify REFUNDED badge exists
    const statusBadge = page.getByText('ĐÃ HOÀN TIỀN');
    await expect(statusBadge).toBeVisible();

    // 3. Verify amber warning styling and explanatory text for 60s timeout refund
    await expect(
      page.getByText('Đã hoàn lại 100% tiền vào ví do nhà cung cấp không phản hồi hoặc quá 60s.')
    ).toBeVisible();

    // 4. Verify no credential box or copy button is rendered
    await expect(page.getByText('Credential')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Sao chép' })).not.toBeVisible();
  });

  test('[P1] should transition OrderSuccessModal from SOURCING to FULFILLED when worker succeeds during polling', async ({ page }) => {
    // THIS TEST WILL FAIL IN RED PHASE - Real-time polling transition from SOURCING to FULFILLED inside modal
    let pollCount = 0;

    await page.route('**/api/wallets/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockInitialWallet),
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
      pollCount++;
      const currentOrder = pollCount <= 1 ? mockSourcingOrder : mockFulfilledOrder;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([currentOrder]),
      });
    });

    await page.goto(miniAppUrl);
    await page.getByRole('button', { name: 'Mua ngay' }).click();
    await page.getByRole('button', { name: 'Xác nhận' }).click();

    // Modal begins in processing state
    await expect(page.getByRole('heading', { name: 'Đơn hàng đang xử lý' })).toBeVisible();

    // Polling triggers -> transitions to FULFILLED state
    await expect(page.getByRole('heading', { name: 'Mua hàng thành công!' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Key / Tài khoản của bạn')).toBeVisible();
    await expect(page.getByText('gpt-upstream-auto-user@external.com:SecureKey!2026')).toBeVisible();

    const copyButton = page.getByRole('button', { name: 'Copy key' });
    await expect(copyButton).toBeVisible();
    await copyButton.click();
    await expect(page.getByRole('button', { name: '✓ Đã copy' })).toBeVisible();
  });

  test('[P1] should actively poll and auto-refresh /orders from SOURCING to REFUNDED without page reload', async ({ page }) => {
    // THIS TEST WILL FAIL IN RED PHASE - OrdersPage active polling for SOURCING status not implemented yet
    let pollCount = 0;

    await page.route('**/api/orders', async (route) => {
      pollCount++;
      const currentOrder = pollCount <= 1 ? mockSourcingOrder : mockRefundedOrder;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([currentOrder]),
      });
    });

    const ordersPromise = page.waitForResponse((res) => res.url().includes('/api/orders') && res.status() === 200);
    await page.goto(`${miniAppUrl}/orders`);
    await ordersPromise;

    // Initially displays SOURCING
    await expect(page.getByText('ĐANG LẤY HÀNG')).toBeVisible();
    await expect(page.getByText('Đang lấy hàng từ nhà cung cấp ngoài…')).toBeVisible();

    // Background polling should update page automatically to REFUNDED
    await expect(page.getByText('ĐÃ HOÀN TIỀN')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText('Đã hoàn lại 100% tiền vào ví do nhà cung cấp không phản hồi hoặc quá 60s.')
    ).toBeVisible();
    await expect(page.getByText('Đang lấy hàng từ nhà cung cấp ngoài…')).not.toBeVisible();
  });

  test('[P2] should stop polling interval when OrderSuccessModal is closed by user', async ({ page }) => {
    // THIS TEST WILL FAIL IN RED PHASE - Modal polling interval cleanup on dismiss
    let ordersPollCount = 0;

    await page.route('**/api/wallets/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockInitialWallet),
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
      ordersPollCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([mockSourcingOrder]),
      });
    });

    await page.goto(miniAppUrl);
    await page.getByRole('button', { name: 'Mua ngay' }).click();
    await page.getByRole('button', { name: 'Xác nhận' }).click();

    await expect(page.getByRole('heading', { name: 'Đơn hàng đang xử lý' })).toBeVisible();

    // Close modal
    const doneButton = page.getByRole('button', { name: 'Xong' });
    await doneButton.click();
    await expect(page.getByRole('heading', { name: 'Đơn hàng đang xử lý' })).not.toBeVisible();

    const countAfterClose = ordersPollCount;
    // Wait longer than polling interval (2.5s) to verify no further requests
    await page.waitForTimeout(3500);

    // Polling count should not have increased after close
    expect(ordersPollCount).toBeLessThanOrEqual(countAfterClose + 1);
  });

  test('[P2] should trigger Telegram WebApp haptic feedback warning on auto-refund', async ({ page }) => {
    // THIS TEST WILL FAIL IN RED PHASE - Haptic feedback 'warning' on transition to REFUNDED
    let pollCount = 0;

    await page.route('**/api/wallets/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockInitialWallet),
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
      pollCount++;
      const currentOrder = pollCount <= 1 ? mockSourcingOrder : mockRefundedOrder;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([currentOrder]),
      });
    });

    await page.goto(miniAppUrl);
    await page.getByRole('button', { name: 'Mua ngay' }).click();
    await page.getByRole('button', { name: 'Xác nhận' }).click();

    await expect(
      page.getByText('Nhà cung cấp tạm hết hàng, hệ thống đã hoàn trả 100% tiền vào ví')
    ).toBeVisible({ timeout: 10_000 });

    const hapticLogs = await page.evaluate(() => (window as any).__telegramHapticLogs as TelegramHapticLogs);
    expect(hapticLogs.notifications).toContain('warning');
  });
});
