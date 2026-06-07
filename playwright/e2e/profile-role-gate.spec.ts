/**
 * E2E: Profile page role-gating
 *
 * Verifies that admin-only sections (DB backup, Security, OIDC, Routing,
 * Network, Observability) are hidden from role=user accounts.
 */
import { test, expect } from '../support/merged-fixtures';
import { createUser } from '../support/factories';

test.describe('Profile: admin sections hidden for user role', () => {
  test('user sees My Account but not admin settings', async ({ page }) => {
    // Given: register via UI flow (sets cookie in page context)
    const user = createUser();
    await page.goto('/register');
    await page.locator('input[type="email"]').fill(user.email);
    const pwInputs = page.locator('input[type="password"]');
    await pwInputs.nth(0).fill(user.password);
    await pwInputs.nth(1).fill(user.password);
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

    // When: navigating to profile/settings
    await page.goto('/dashboard/profile');
    await page.waitForLoadState('networkidle');

    // Then: user sees their profile card
    await expect(page.getByText('My Account')).toBeVisible({ timeout: 10_000 });

    // And: admin sections are NOT visible
    await expect(page.getByText('Database Location')).not.toBeVisible();
    await expect(page.getByText('Download Backup')).not.toBeVisible();
    await expect(page.getByText('Require login')).not.toBeVisible();
    await expect(page.getByText('OIDC Dashboard Login')).not.toBeVisible();
    await expect(page.getByText('Routing Strategy')).not.toBeVisible();
    await expect(page.getByText('Outbound Proxy')).not.toBeVisible();
    await expect(page.getByText('Enable Observability')).not.toBeVisible();
  });
});
