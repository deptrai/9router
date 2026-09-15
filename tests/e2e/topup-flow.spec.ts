import { test, expect, Page } from '@playwright/test';

/**
 * Story 2.1 & 2.3: Telegram Mini App Wallet Topup E2E Test Suite
 * Covers VietQR and Crypto (Bitcart) payment flows
 */

const MINI_APP_URL = process.env.MINI_APP_URL || 'http://localhost:3005';

async function mockTelegramWebApp(page: Page) {
  await page.addInitScript(() => {
    (window as any).Telegram = {
      WebApp: {
        ready: () => {},
        expand: () => {},
        initData: 'query_id=test_topup_query&user=%7B%22id%22%3A123456%2C%22first_name%22%3A%22Alex%22%7D',
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

const mockWallet = {
  ok: true,
  wallet: {
    id: 'wallet-topup-01',
    balance: '150000',
    currency: 'VND',
  },
};

const mockVietQrResponse = {
  ok: true,
  payment: {
    id: 'pay-vietqr-123',
    type: 'vietqr',
    status: 'PENDING',
    amount: 100000,
    currency: 'VND',
    bankAccount: '9876543210',
    bankName: 'MB Bank',
    transferContent: 'TOPUP123456',
    qrImageUrl: 'https://img.vietqr.io/image/MB-9876543210-compact.png?amount=100000&addInfo=TOPUP123456',
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    createdAt: new Date().toISOString(),
  },
};

const mockCryptoResponse = {
  ok: true,
  payment: {
    id: 'pay-crypto-456',
    type: 'crypto',
    status: 'PENDING',
    amount: 200000,
    currency: 'VND',
    metadata: {
      cryptoCurrency: 'USDT',
      network: 'TRON',
      cryptoAmount: '7.85',
      payAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      paymentUrl: 'https://bitcart.example.com/i/123',
    },
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    createdAt: new Date().toISOString(),
  },
};

test.describe('Mini App Topup Flow E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await mockTelegramWebApp(page);

    // Network-first route interception before navigation
    await page.route('**/api/wallets/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockWallet),
      });
    });
  });

  test('[P0] Topup page loads with preset amount buttons and active VietQR tab', async ({ page }) => {
    await page.goto(`${MINI_APP_URL}/topup`);

    // Verify header and navigation
    await expect(page.getByRole('heading', { name: 'Nạp tiền' })).toBeVisible();

    // Verify preset amounts
    await expect(page.getByRole('button', { name: '50.000đ' })).toBeVisible();
    await expect(page.getByRole('button', { name: '100.000đ' })).toBeVisible();
    await expect(page.getByRole('button', { name: '200.000đ' })).toBeVisible();
    await expect(page.getByRole('button', { name: '500.000đ' })).toBeVisible();

    // Verify tabs
    await expect(page.getByRole('button', { name: 'VietQR' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Crypto' })).toBeVisible();
  });

  test('[P0] Creates VietQR payment request on preset selection and displays transfer instructions', async ({ page }) => {
    await page.route('**/api/payments/topup/vietqr', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(mockVietQrResponse),
      });
    });

    await page.goto(`${MINI_APP_URL}/topup`);

    // Select 100.000đ preset
    await page.getByRole('button', { name: '100.000đ' }).click();

    // Click submit button
    const submitButton = page.getByRole('button', { name: 'Tạo mã QR' });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // Verify VietQR details displayed
    await expect(page.getByText('Quét mã QR để chuyển khoản')).toBeVisible();
    await expect(page.getByText('9876543210')).toBeVisible();
    await expect(page.getByText('MB Bank')).toBeVisible();
    await expect(page.getByText('TOPUP123456')).toBeVisible();
  });

  test('[P1] Validates custom topup amount minimum boundary (10.000đ)', async ({ page }) => {
    await page.goto(`${MINI_APP_URL}/topup`);

    // Enter amount less than 10.000đ
    const input = page.getByPlaceholder('VD: 150.000');
    await input.fill('5000');

    // Click submit button - should trigger minimum validation error
    const submitButton = page.getByRole('button', { name: 'Tạo mã QR' });
    await submitButton.click();

    await expect(page.getByText(/Số tiền tối thiểu là 10.000/i)).toBeVisible();
  });

  test('[P0] Switches to Crypto tab and creates USDT TRON payment invoice', async ({ page }) => {
    await page.route('**/api/payments/topup/bitcart', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(mockCryptoResponse),
      });
    });

    await page.goto(`${MINI_APP_URL}/topup`);

    // Switch to Crypto tab
    await page.getByRole('button', { name: 'Crypto' }).click();

    // Verify crypto selector visible
    await expect(page.getByText('Chọn coin')).toBeVisible();
    await expect(page.getByText('Chọn network')).toBeVisible();

    // Select preset amount
    await page.getByRole('button', { name: '200.000đ' }).click();

    // Click submit button
    const submitCryptoBtn = page.getByRole('button', { name: 'Tạo hóa đơn Crypto' });
    await expect(submitCryptoBtn).toBeEnabled();
    await submitCryptoBtn.click();

    // Verify crypto invoice details displayed
    await expect(page.getByText('Chuyển crypto để nạp tiền')).toBeVisible();
    await expect(page.getByText('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBeVisible();
    await expect(page.getByText('7.85')).toBeVisible();
  });

  test('[P0] Automatically detects wallet balance increase and displays success confirmation', async ({ page }) => {
    let pollCount = 0;
    await page.route('**/api/wallets/me', async (route) => {
      pollCount++;
      if (pollCount > 1) {
        // Updated balance after payment credited
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            wallet: {
              id: 'wallet-topup-01',
              balance: '250000', // +100.000đ
              currency: 'VND',
            },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockWallet),
        });
      }
    });

    await page.route('**/api/payments/topup/vietqr', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(mockVietQrResponse),
      });
    });

    await page.goto(`${MINI_APP_URL}/topup`);
    await page.getByRole('button', { name: '100.000đ' }).click();
    await page.getByRole('button', { name: 'Tạo mã QR' }).click();

    // Await success message to appear on credited balance
    await expect(page.getByText(/Đã nhận 100.000/i)).toBeVisible({ timeout: 10000 });
  });
});
