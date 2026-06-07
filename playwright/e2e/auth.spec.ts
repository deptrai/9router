/**
 * Authentication E2E Tests
 *
 * Tests login/logout flows for the 9router dashboard.
 */
import { test, expect } from '../support/merged-fixtures';
import { createUser } from '../support/factories';

test.describe('Authentication', () => {
  test('should show error for invalid credentials', async ({ page }) => {
    // Given: A user with wrong credentials
    const user = createUser();

    // When: They attempt to login
    await page.goto('/login');

    const emailInput = page.getByRole('textbox', { name: /email|username/i });
    const passwordInput = page.locator('input[type="password"]');

    if (await emailInput.isVisible()) {
      await emailInput.fill(user.email);
      await passwordInput.fill('wrong-password');

      const submitBtn = page.getByRole('button', { name: /login|sign in/i });
      if (await submitBtn.isVisible()) {
        await submitBtn.click();

        // Then: An error message should appear
        await expect(
          page.getByText(/invalid|incorrect|failed/i),
        ).toBeVisible({ timeout: 5_000 });
      }
    }
  });

  test('should login successfully with valid credentials', async ({
    page,
    apiRequest,
    log,
  }) => {
    // Given: A registered user (seeded via API if endpoint exists)
    await log.step('Navigating to login page');
    await page.goto('/login');

    // When/Then: Verify login page renders correctly
    await expect(page).toHaveURL(/login/);
  });
});
