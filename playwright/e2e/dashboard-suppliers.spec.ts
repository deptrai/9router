/**
 * Dashboard: Supplier Sources CRUD UI (Story 2-38.1)
 *
 * E2E browser flow for add/edit supplier source, focused on the
 * telegram_bot_scraper adapter. Requires the dev server running on BASE_URL.
 */
import { test, expect } from '../support/merged-fixtures';
import { mintAdminToken } from '../support/helpers/admin-token';

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${test.info().workerIndex}-${test.info().testId}`;
}

test.describe('Dashboard: Supplier Sources CRUD UI', () => {
  test.beforeEach(async ({ page, apiBaseUrl }) => {
    const token = await mintAdminToken();
    const url = new URL(apiBaseUrl);
    await page.context().addCookies([
      {
        name: 'auth_token',
        value: token,
        domain: url.hostname,
        path: '/',
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ]);
  });

  test('admin can add a telegram_bot_scraper supplier source', async ({ page, apiRequest }) => {
    const name = uniqueName('e2e-scraper');

    await page.goto('/dashboard/suppliers');
    await expect(page.getByRole('heading', { name: 'Supplier Sources' })).toBeVisible();

    // Open add modal
    await page.getByRole('button', { name: 'Add supplier source' }).click();
    await expect(page.getByRole('heading', { name: 'Add supplier source' })).toBeVisible();

    // Generic fields
    await page.locator('#supplier-source-name').fill(name);
    await page.locator('#supplier-source-adapter').selectOption('telegram_bot_scraper');
    await page.locator('#supplier-source-sync-mode').selectOption('polling');
    await page.locator('#supplier-source-sync-interval').fill('3600');

    // Telegram scraper fields
    await page.locator('#supplier-source-bot-username').fill('tainguyenvibebot');
    await page.locator('#supplier-source-vnd-per-credit').fill('1000');
    await page.locator('#supplier-source-relay-url').fill('http://127.0.0.1:3800/relay');
    await page.locator('#supplier-source-relay-token').fill('test-relay-token');

    // Use proxy_checkout to keep the E2E test simple (no purchase flow needed)
    await page.locator('#supplier-source-payment-mode').selectOption('proxy_checkout');

    // Single command mode
    await page.getByRole('radio', { name: 'Single command' }).check();
    await page.locator('#supplier-source-command').fill('/products');

    // Submit and wait for the API call
    const createPromise = page.waitForResponse((res) =>
      res.url().includes('/api/store/suppliers') && res.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Create' }).click();
    const createRes = await createPromise;
    expect(createRes.status()).toBe(201);

    // Modal closes and the new source appears in the list
    await expect(page.getByText(name)).toBeVisible();

    // Cleanup
    const body = await createRes.json() as { source?: { id: string } };
    if (body.source?.id) {
      await apiRequest({ method: 'DELETE', path: `/api/store/suppliers/${body.source.id}` });
    }
  });

  test('admin can edit a supplier source (generic fields only)', async ({ page, apiRequest }) => {
    const name = uniqueName('e2e-edit');
    const create = await apiRequest({
      method: 'POST',
      path: '/api/store/suppliers',
      data: {
        name,
        adapterType: 'telegram_bot_scraper',
        syncMode: 'polling',
        syncIntervalSec: 3600,
        auth: {
          botUsername: 'tainguyenvibebot',
          vndPerCredit: 1000,
          relayUrl: 'http://127.0.0.1:3800/relay',
          relayToken: 'test-relay-token',
          command: '/products',
        },
      },
    });
    expect(create.status).toBe(201);
    const id = (create.body as { source: { id: string } }).source.id;

    await page.goto('/dashboard/suppliers');
    await expect(page.getByRole('heading', { name: 'Supplier Sources' })).toBeVisible();

    // Find the row and click Edit
    const row = page.getByRole('row').filter({ hasText: name });
    await row.getByRole('button', { name: 'Edit' }).click();

    // Change sync interval without touching credentials (updateCredentials off by default)
    await page.getByLabel('Sync interval (sec)').fill('7200');

    const updatePromise = page.waitForResponse((res) =>
      res.url().includes(`/api/store/suppliers/${id}`) && res.request().method() === 'PUT'
    );
    await page.getByRole('button', { name: 'Save' }).click();
    const updateRes = await updatePromise;
    expect(updateRes.status()).toBe(200);

    // Cleanup
    await apiRequest({ method: 'DELETE', path: `/api/store/suppliers/${id}` });
  });

  test('admin can add a telegram_bot_scraper source with interactive steps', async ({ page, apiRequest }) => {
    const name = uniqueName('e2e-interactive');

    await page.goto('/dashboard/suppliers');
    await page.getByRole('button', { name: 'Add supplier source' }).click();
    await expect(page.getByRole('heading', { name: 'Add supplier source' })).toBeVisible();

    // Generic fields
    await page.locator('#supplier-source-name').fill(name);
    await page.locator('#supplier-source-adapter').selectOption('telegram_bot_scraper');
    await page.locator('#supplier-source-sync-mode').selectOption('polling');
    await page.locator('#supplier-source-sync-interval').fill('3600');

    // Telegram scraper fields
    await page.locator('#supplier-source-bot-username').fill('tainguyenvibebot');
    await page.locator('#supplier-source-vnd-per-credit').fill('1000');
    await page.locator('#supplier-source-relay-url').fill('http://127.0.0.1:3800/relay');
    await page.locator('#supplier-source-relay-token').fill('test-relay-token');

    // Use proxy_checkout to keep the E2E test simple
    await page.locator('#supplier-source-payment-mode').selectOption('proxy_checkout');

    // Switch to interactive steps and fill the default step
    await page.getByRole('radio', { name: 'Interactive steps' }).check();
    await expect(page.getByText('Add step', { exact: false })).toBeVisible();
    await page.locator('input[placeholder="Message text, e.g. /start"]').fill('/start');

    const createPromise = page.waitForResponse((res) =>
      res.url().includes('/api/store/suppliers') && res.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Create' }).click();
    const createRes = await createPromise;
    expect(createRes.status()).toBe(201);

    await expect(page.getByText(name)).toBeVisible();

    const body = await createRes.json() as { source?: { id: string } };
    if (body.source?.id) {
      await apiRequest({ method: 'DELETE', path: `/api/store/suppliers/${body.source.id}` });
    }
  });
});
