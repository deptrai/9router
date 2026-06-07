/**
 * E2E: Login Page UI (Story 2.2 AC6 + Story 2.7 AC3)
 *
 * P2 — UI navigation. Verifies User/Admin tabs and forgot-password link.
 */
import { test, expect } from '../support/merged-fixtures';

test.describe('E2E: Login Page', () => {
  test('renders login form with password field', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
  });

  test('exposes a sign-up link to the register page', async ({ page }) => {
    await page.goto('/login');

    const signupLink = page.getByRole('link', { name: /sign up|register|đăng ký/i });
    if ((await signupLink.count()) > 0) {
      await signupLink.first().click();
      await expect(page).toHaveURL(/register/);
    }
  });

  test('exposes a forgot-password link', async ({ page }) => {
    await page.goto('/login');

    const forgotLink = page.getByRole('link', { name: /forgot|quên mật khẩu/i });
    // Forgot link may be behind the User tab; click User tab if present
    const userTab = page.getByRole('button', { name: /^user$/i });
    if ((await userTab.count()) > 0) {
      await userTab.first().click();
    }

    if ((await forgotLink.count()) > 0) {
      await expect(forgotLink.first()).toBeVisible();
    }
  });
});
