/**
 * Dashboard E2E Tests
 *
 * Verifies core dashboard functionality with network interception.
 * Demonstrates: Given/When/Then, data-testid selectors, factory usage.
 */
import { test, expect } from '../support/merged-fixtures';

test.describe('Dashboard', () => {
  test('should display login page for unauthenticated user', async ({ page }) => {
    // Given: An unauthenticated user
    // When: They navigate to the dashboard
    await page.goto('/');

    // Then: They should see the login form
    await expect(page.getByRole('heading')).toBeVisible();
  });

  test('should intercept API calls on dashboard load', async ({
    page,
    interceptNetworkCall,
  }) => {
    // Given: Network interception is active
    // This is a placeholder demonstrating the interceptNetworkCall pattern.
    // Replace with actual API endpoint monitoring when implementing real tests.

    // When: User navigates to the app
    await page.goto('/');

    // Then: Page loads successfully
    await page.waitForLoadState('domcontentloaded');
  });
});
