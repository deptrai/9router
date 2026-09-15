import { test, expect } from '@playwright/test';

const MINI_APP_URL = process.env.MINI_APP_URL || 'http://localhost:3000';
// Dev Telegram initData — must match the server's expected user/session.
const TG_INIT_DATA =
  process.env.NEXT_PUBLIC_DEV_TG_INIT_DATA ||
  'auth_date=1789133272&user=%7B%22id%22%3A123456%2C%22first_name%22%3A%22Alice%22%2C%22username%22%3A%22alice_test%22%2C%22language_code%22%3A%22vi%22%2C%22is_premium%22%3Afalse%7D&hash=c9be63e21378552b216e30b0d395f3aaef7be616fca243927f1dc7e3951e3d7f';

/**
 * E2E Test Suite for Story 3.4: Bàn giao Credential Tức thì & Lịch sử Đơn hàng
 * - AC #1: Hiển thị credential ngay sau khi mua cùng nút "Sao chép" và link "Xem đơn hàng →"
 * - AC #2: Gửi thông báo Telegram Bot (fire-and-forget không gián đoạn checkout)
 * - AC #3: Đơn hàng hiển thị vĩnh viễn trong tab "Đơn hàng của tôi" với đầy đủ thông tin và credential
 */
test.describe('Story 3.4: Orders & Immediate Credential Handover', () => {
  test.beforeEach(async ({ page }) => {
    // Block the real Telegram SDK so our initData stub is not overwritten.
    await page.route('**/telegram.org/js/telegram-web-app.js**', (route) => route.abort());
    // Inject Telegram initData so apiClient can attach `Authorization: tma ...`.
    await page.addInitScript((initData) => {
      (window as any).__telegramInitData = initData;
      (window as any).Telegram = {
        WebApp: {
          ready: () => {},
          expand: () => {},
          initData,
          initDataUnsafe: { user: { id: 123456, first_name: 'Alice' } },
          HapticFeedback: {
            impactOccurred: () => {},
            notificationOccurred: () => {},
            selectionChanged: () => {},
          },
        },
      };
    }, TG_INIT_DATA);
    await page.goto(MINI_APP_URL);
    await page.waitForLoadState('networkidle');
  });

  test('[P1] Bottom navigation toggles between Store and Orders tabs', async ({ page }) => {
    // 1. Verify BottomNav presence
    const storeTab = page.locator('a[href="/"]');
    const ordersTab = page.locator('a[href="/orders"]');

    await expect(storeTab).toBeVisible();
    await expect(ordersTab).toBeVisible();

    // 2. Navigate to Orders tab
    await ordersTab.click();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole('heading', { name: 'Đơn hàng của tôi' })).toBeVisible();

    // 3. Return to Store tab
    await storeTab.click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('Complete purchase flow: one-tap checkout, credential modal, and orders history', async ({ page }) => {
    // Deterministic mocks: a funded wallet, an in-stock IN_HOUSE product, an
    // instantly-FULFILLED checkout, and the order appearing in /api/orders.
    const mockProduct = {
      id: 'prod-story34',
      title: 'Story 3.4 Test Product',
      description: 'In-house instant-delivery product',
      price: '50000',
      category: 'Test',
      stockStatus: 'IN_STOCK',
      sourcingMode: 'IN_HOUSE',
      imageUrl: '',
    };
    const mockOrder = {
      id: 'ord-story34-001',
      productId: 'prod-story34',
      productTitle: 'Story 3.4 Test Product',
      price: '50000',
      status: 'FULFILLED',
      createdAt: new Date().toISOString(),
      deliveredCredential: 'story34-user@example.com:SecretKey!2026',
    };

    await page.route('**/api/wallets/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, wallet: { id: 'w1', balance: '500000', currency: 'VND' } }),
      })
    );
    await page.route('**/api/products', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, products: [mockProduct] }),
      })
    );
    await page.route('**/api/orders/checkout', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, order: mockOrder, deliveredCredential: mockOrder.deliveredCredential }),
      })
    );
    await page.route(/\/api\/orders\/?$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([mockOrder]) })
    );

    // Reload so the page picks up the mocked catalog/wallet.
    await page.reload();
    await page.waitForLoadState('networkidle');

    // 1. Select the in-stock product
    const buyButton = page.getByRole('button', { name: 'Mua ngay' }).first();
    await buyButton.click();

    // 2. Checkout modal appears
    await expect(page.getByRole('heading', { name: 'Xác nhận mua hàng' })).toBeVisible();
    const confirmButton = page.getByRole('button', { name: 'Xác nhận' });
    await confirmButton.click();

    // 3. Success modal displays credential and copy button
    await expect(page.getByRole('heading', { name: 'Mua hàng thành công!' })).toBeVisible();
    await expect(page.getByText('Key / Tài khoản của bạn')).toBeVisible();

    const copyBtn = page.locator('button:has-text("Copy key")');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // 4. Navigate to Orders history via link in modal
    const viewOrdersLink = page.locator('a:has-text("Xem đơn hàng →")');
    await expect(viewOrdersLink).toBeVisible();
    await viewOrdersLink.click();

    // 5. Verify order is displayed in history tab
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole('heading', { name: 'Đơn hàng của tôi' })).toBeVisible();

    // Status badge and credential box are present
    await expect(page.getByText('FULFILLED')).toBeVisible();
    await expect(page.getByText('Credential')).toBeVisible();
    await expect(page.getByText('Sử dụng key/tài khoản trên để kích hoạt sản phẩm.')).toBeVisible();

    const orderCopyBtn = page.locator('button:has-text("Sao chép")').first();
    await expect(orderCopyBtn).toBeVisible();
    await orderCopyBtn.click();
  });
});
