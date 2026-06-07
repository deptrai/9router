/**
 * Custom 9router fixtures
 *
 * Project-specific fixtures extending base Playwright test.
 */
import { test as base } from '@playwright/test';
import { createUser, type User } from '../factories/user-factory';

type CustomFixtures = {
  /** Auto-seeded test user via API */
  testUser: User;
  /** Base API URL for direct fetch calls */
  apiBaseUrl: string;
};

export const test = base.extend<CustomFixtures>({
  apiBaseUrl: async ({}, use) => {
    const url = process.env.API_URL || process.env.BASE_URL || 'http://localhost:20128';
    await use(url);
  },

  testUser: async ({ request }, use) => {
    const user = createUser();

    // Seed user via API (if seeding endpoint available)
    // await request.post('/api/admin/seed/user', { data: user });

    await use(user);

    // Cleanup (if cleanup endpoint available)
    // await request.delete(`/api/admin/users/${user.id}`);
  },
});
