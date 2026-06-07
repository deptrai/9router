/**
 * E2E: Register Page UI (Story 2.2 AC6)
 *
 * P2 — UI happy path. Register via the form, expect redirect to /dashboard.
 *
 * Note: the register form labels are not associated to inputs via htmlFor,
 * so we select by input type (email / password) and button text.
 */
import { test, expect } from '../support/merged-fixtures';
import { createUser } from '../support/factories';

test.describe('E2E: Register Page', () => {
  test('renders the register form', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /create account/i })).toBeVisible();
  });

  test('registers a new user and redirects to dashboard', async ({ page }) => {
    const user = createUser();

    await page.goto('/register');

    // Email
    await page.locator('input[type="email"]').fill(user.email);

    // Password + Confirm Password (two password inputs)
    const passwordInputs = page.locator('input[type="password"]');
    await passwordInputs.nth(0).fill(user.password);
    await passwordInputs.nth(1).fill(user.password);

    await page.getByRole('button', { name: /create account/i }).click();

    // Then: redirected to dashboard
    await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });
  });
});
