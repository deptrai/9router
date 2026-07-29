/**
 * Dashboard: Store Admin — publish all variants in a product group (Story 2-38.2 T5)
 *
 * Browser E2E: seed a supplier source, push two external products with the same name,
 * then open /dashboard/store and click "Publish all variants" in the group card.
 */
import { test, expect } from '../support/merged-fixtures';
import { mintAdminToken } from '../support/helpers/admin-token';

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${process.pid}-${test.info().workerIndex}-${test.info().testId}`;
}

test.describe('Dashboard: Store Admin — publish group', () => {
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

  test('admin can publish all variants in a product group', async ({ page, apiRequest }) => {
    // Auto-accept the browser confirm() dialog so publish actions do not stall.
    page.on('dialog', (dialog) => dialog.accept());

    const groupProductName = uniqueName('E2E Group Product');
    const webhookSecret = 'wh-secret-' + Date.now();

    // 1. Create a global markup rule so external products get a retail price.
    const markupRes = await apiRequest({
      method: 'POST',
      path: '/api/store/markup-rules',
      data: { markupPct: 20, roundingRule: 'ceil', isActive: true },
    });
    expect(markupRes.status).toBe(201);

    // 2. Create a telegram_bot_scraper source in webhook mode.
    const sourceRes = await apiRequest({
      method: 'POST',
      path: '/api/store/suppliers',
      data: {
        name: uniqueName('e2e-webhook-source'),
        adapterType: 'telegram_bot_scraper',
        syncMode: 'webhook',
        paymentMode: 'proxy_checkout',
        auth: {
          botUsername: 'testbot',
          vndPerCredit: 1000,
          relayUrl: 'http://127.0.0.1:3800/relay',
          relayToken: 'test-relay-token',
          webhookSecret,
          command: '/products',
        },
      },
    });
    expect(sourceRes.status).toBe(201);
    const sourceId = (sourceRes.body as { source: { id: string } }).source.id;

    // 3. Push two external products with the same name (same group) but different supplierProductId.
    for (const suffix of ['A', 'B']) {
      const push = await apiRequest({
        method: 'POST',
        path: `/api/store/suppliers/webhook/${sourceId}`,
        data: {
          supplierProductId: `prod-${suffix}-${Date.now()}`,
          name: groupProductName,
          priceCredits: 100,
          stock: 5,
          description: 'group variant',
        },
        headers: { 'x-webhook-secret': webhookSecret },
      });
      expect(push.status).toBe(200);
    }

    // 4. Open the admin store page.
    await page.goto('/dashboard/store');
    await expect(page.getByRole('heading', { name: 'Store Management' })).toBeVisible();

    // 5. The newest group is at the top; find its "Publish all variants" button.
    const publishButton = page.locator('button[title="Publish all variants in group"]').first();
    await expect(publishButton).toHaveText('Publish all variants');

    // 6. Click and wait for the publish-group API call.
    const publishPromise = page.waitForResponse((res) =>
      res.url().includes('/api/store/admin/products/publish-group') && res.request().method() === 'POST'
    );
    await publishButton.click();
    const publishRes = await publishPromise;
    expect(publishRes.status()).toBe(200);
    const publishBody = await publishRes.json() as { published?: number };
    expect(publishBody.published).toBe(2);

    // 7. After reload, the button should become "All Published" and all variants show "Published".
    await expect(publishButton).toHaveText('All Published');
    const groupCard = publishButton.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
    const publishedBadges = groupCard.locator('span:has-text("Published")');
    await expect(publishedBadges).toHaveCount(2);

    // Cleanup: unpublish products so they do not interfere with other tests.
    const listRes = await apiRequest({ method: 'GET', path: '/api/store/admin/products' });
    const products = (listRes.body as { products: { id: string; name: string; source: string }[] }).products;
    for (const p of products.filter((p) => p.name === groupProductName && p.source !== 'local')) {
      await apiRequest({
        method: 'POST',
        path: `/api/store/products/${p.id}/publish?action=unpublish`,
      });
    }
    await apiRequest({ method: 'DELETE', path: `/api/store/suppliers/${sourceId}` });
  });
});
