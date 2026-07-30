import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const USER = { id: 999999999, first_name: 'Test', username: 'testuser' };
const BASE_URL = process.env.STORE_URL || process.env.BASE_URL || 'http://localhost:20128';
const STORE_URL = `${BASE_URL.replace(/\/$/, '')}/telegram/store`;

function buildInitData(user: typeof USER) {
  const auth_date = Math.floor(Date.now() / 1000).toString();
  const query_id = 'Q' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const userJson = JSON.stringify(user);

  const params = new URLSearchParams({ auth_date, query_id, user: userJson });
  const pairs: string[] = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();
  const hash = crypto
    .createHmac('sha256', secret)
    .update(dataCheckString)
    .digest('hex');

  return {
    initData: params.toString() + '&hash=' + hash,
    initDataUnsafe: { query_id, user, auth_date: Number(auth_date), hash },
  };
}

async function injectTelegramWebApp(
  page: any,
  initData: string,
  initDataUnsafe: Record<string, any>
) {
  await page.addInitScript(
    (data: { initData: string; initDataUnsafe: Record<string, any> }) => {
      (window as any).__lastSentData = undefined;
      (window as any).__telegramInitData = data.initData;
      (window as any).Telegram = {
        WebApp: {
          initData: data.initData,
          initDataUnsafe: data.initDataUnsafe,
          ready: () => {},
          expand: () => {},
          showAlert: (msg: string) => console.log('ALERT', msg),
          sendData: (payload: string) => {
            console.log('SEND_DATA', payload);
            try {
              (window as any).__lastSentData = JSON.parse(payload);
            } catch {
              (window as any).__lastSentData = payload;
            }
          },
          isExpanded: true,
          viewportHeight: 600,
        },
      };
    },
    { initData, initDataUnsafe }
  );
}

test.describe('Telegram Store WebApp', () => {
  test.beforeAll(() => {
    const dataDir = process.env.DATA_DIR || '/app/data';
    const dbPath = `${dataDir}/db/data.sqlite`;
    try {
      execSync(
        `sqlite3 "${dbPath}" "PRAGMA busy_timeout = 10000; ` +
          `INSERT OR IGNORE INTO users (id, email, passwordHash, displayName, isActive, isEmailVerified, creditsBalance, createdAt, updatedAt, telegramId) ` +
          `VALUES (lower(hex(randomblob(16))), 'telegram_999999999@placeholder.local', '!', 'Test', 1, 0, 0, datetime('now'), datetime('now'), '999999999'); ` +
          `INSERT OR IGNORE INTO creditTransactions (id, userId, type, bucket, amount, balanceAfter, note, createdAt, idempotencyKey) ` +
          `SELECT lower(hex(randomblob(16))), u.id, 'seed', 'standard', 10000, ` +
          `COALESCE((SELECT SUM(ct.amount) FROM creditTransactions ct WHERE ct.userId = u.id AND (ct.expiresAt IS NULL OR ct.expiresAt > datetime('now'))), 0) + 10000, ` +
          `'Test seed', datetime('now'), 'seed:test:999999999:standard' ` +
          `FROM users u WHERE u.telegramId = '999999999'; ` +
          `UPDATE users SET creditsBalance = (SELECT COALESCE(SUM(ct.amount), 0) FROM creditTransactions ct WHERE ct.userId = users.id AND (ct.expiresAt IS NULL OR ct.expiresAt > datetime('now'))) ` +
          `WHERE telegramId = '999999999'; ` +
          `INSERT OR REPLACE INTO products (id, kind, name, description, priceCredits, deliveryMode, stock, isActive, isPublished, source, createdAt, updatedAt) ` +
          `VALUES ('550e8400-e29b-41d4-a716-446655440000', 'service', 'E2E Telegram Store Product', 'Test product for Telegram Store WebApp', 10, 'instant', NULL, 1, 1, 'local', datetime('now'), datetime('now'));"`,
        { stdio: 'ignore' }
      );
    } catch (e) {
      console.log('[e2e] could not seed test data:', e);
    }
  });

  test('valid initData: can buy product', async ({ page }) => {
    test.skip(!BOT_TOKEN, 'requires TELEGRAM_BOT_TOKEN env');
    const errors: Error[] = [];
    page.on('pageerror', (err) => errors.push(err));

    const { initData, initDataUnsafe } = buildInitData(USER);
    await injectTelegramWebApp(page, initData, initDataUnsafe);

    await page.goto(STORE_URL);
    await page.waitForTimeout(3000);

    await expect(page.getByText('Mua ngay').first()).toBeVisible();
    await expect(page.getByText('Tạm hết hàng')).toHaveCount(0);
    expect(errors).toHaveLength(0);

    // Click Mua ngay -> modal Xác nhận mua
    await page.getByRole('button', { name: 'Mua ngay' }).first().click();
    await expect(page.getByRole('button', { name: 'Xác nhận mua' }).first()).toBeVisible();

    // Confirm -> API miniapp-buy, wait for success
    await page.getByRole('button', { name: 'Xác nhận mua' }).first().click();
    await expect(page.getByText('Mã đơn:').first()).toBeVisible({ timeout: 10000 });

    const result = await page.evaluate(() => (window as any).__lastSentData);
    expect(result).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  test('no initData but Telegram.WebApp present: shows Mua ngay (reply-keyboard mode)', async ({ page }) => {
    const errors: Error[] = [];
    page.on('pageerror', (err) => errors.push(err));

    await injectTelegramWebApp(page, '', {});

    await page.goto(STORE_URL);
    await page.waitForTimeout(3000);

    await expect(page.getByText('Mua ngay').first()).toBeVisible();
    await expect(page.getByText('Mở từ bot để mua')).toHaveCount(0);
    await expect(page.getByText('Tạm hết hàng')).toHaveCount(0);

    // Even without initData, click Mua ngay should call sendData (reply-keyboard mini app behavior).
    await page.getByRole('button', { name: 'Mua ngay' }).first().click();
    await page.waitForFunction(() => !!(window as any).__lastSentData);

    const sent = await page.evaluate(() => (window as any).__lastSentData);
    console.log('SEND_DATA payload:', JSON.stringify(sent));
    expect(sent).toMatchObject({
      action: 'buy',
      productId: expect.any(String),
    });
    expect(errors).toHaveLength(0);
  });

  test('real tgWebAppData hash: buttons show Mua ngay and no hydration error', async ({ page }) => {
    test.skip(!BOT_TOKEN, 'requires TELEGRAM_BOT_TOKEN env');
    const errors: Error[] = [];
    page.on('pageerror', (err) => errors.push(err));

    const { initData } = buildInitData(USER);
    const url = `${STORE_URL}#tgWebAppData=${encodeURIComponent(initData)}`;
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    await expect(page.getByText('Mua ngay').first()).toBeVisible();
    await expect(page.getByText('Mở từ bot để mua')).toHaveCount(0);
    await expect(page.getByText('Tạm hết hàng')).toHaveCount(0);

    const state = await page.evaluate(() => ({
      initDataLen: (window as any).__telegramInitData?.length || 0,
      webAppInitDataLen: (window as any).Telegram?.WebApp?.initData?.length || 0,
    }));
    expect(state.initDataLen).toBeGreaterThan(0);
    expect(state.webAppInitDataLen).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });
});
