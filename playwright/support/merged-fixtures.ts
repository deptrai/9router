/**
 * Merged Fixtures — Single import point for all E2E tests
 *
 * Currently uses native Playwright fixtures + custom 9router fixtures.
 *
 * When @seontechnologies/playwright-utils becomes available on npm,
 * replace this file with the mergeTests composition pattern:
 *
 *   import { mergeTests } from '@playwright/test';
 *   import { test as apiRequestFixture } from '@seontechnologies/playwright-utils/api-request/fixtures';
 *   // ... etc
 *   export const test = mergeTests(apiRequestFixture, authFixture, ...);
 *
 * For now, we provide equivalent lightweight fixtures inline.
 */
import { test as base, expect } from '@playwright/test';
import { createUser, type User } from './factories/user-factory';
import { adminCookieHeader } from './helpers/admin-token';

type CustomFixtures = {
  /** Typed API request helper */
  apiRequest: (opts: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    path: string;
    data?: unknown;
    headers?: Record<string, string>;
  }) => Promise<{ status: number; body: unknown; headers: Record<string, string> }>;

  /** Auto-seeded test user */
  testUser: User;

  /** Base API URL */
  apiBaseUrl: string;

  /** Simple logger for Playwright reports */
  log: {
    step: (message: string) => Promise<void>;
  };

  /** Network interception helper (UI tests) */
  interceptNetworkCall: (opts: { url: string }) => Promise<{
    responseJson?: unknown;
    status?: number;
  }>;
};

export const test = base.extend<CustomFixtures>({
  apiBaseUrl: async ({}, use) => {
    const url = process.env.BASE_URL || 'http://localhost:20128';
    await use(url);
  },

  apiRequest: async ({ request }, use) => {
    // Story 2.28 AC9: requireAdmin() denies unauthenticated requests. The
    // apiRequest fixture is the admin CRUD surface, so it carries an admin
    // auth_token cookie by default. Tests that need to assert the unauth path
    // (AC9) use the raw `request` fixture instead, which has no cookie.
    const cookie = await adminCookieHeader();
    // Track the latest auth_token from Set-Cookie so register/login responses
    // replace the default admin cookie for subsequent calls in the same test.
    let currentCookie = cookie;
    const apiRequestFn = async (opts: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
      path: string;
      data?: unknown;
      headers?: Record<string, string>;
    }) => {
      const response = await request[opts.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch'](
        opts.path,
        {
          ...(opts.data ? { data: opts.data } : {}),
          headers: { Cookie: currentCookie, ...(opts.headers || {}) },
        },
      );

      // Update cookie if the server set a new auth_token (e.g. register/login)
      const setCookie = response.headers()['set-cookie'];
      if (setCookie) {
        const authTokenMatch = setCookie.match(/auth_token=([^;]+)/);
        if (authTokenMatch) {
          currentCookie = `auth_token=${authTokenMatch[1]}`;
        }
      }

      let body: unknown;
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('application/json')) {
        body = await response.json();
      } else {
        body = await response.text();
      }

      return {
        status: response.status(),
        body,
        headers: response.headers(),
      };
    };

    await use(apiRequestFn);
  },

  testUser: async ({}, use) => {
    const user = createUser();
    await use(user);
  },

  log: async ({}, use, testInfo) => {
    await use({
      step: async (message: string) => {
        await testInfo.attach('log', {
          body: `[${new Date().toISOString()}] ${message}`,
          contentType: 'text/plain',
        });
      },
    });
  },

  interceptNetworkCall: async ({ page }, use) => {
    const interceptFn = async (opts: { url: string }) => {
      const responsePromise = page.waitForResponse(opts.url);
      const response = await responsePromise;

      let responseJson: unknown;
      try {
        responseJson = await response.json();
      } catch {
        // Not JSON
      }

      return {
        responseJson,
        status: response.status(),
      };
    };

    await use(interceptFn);
  },
});

export { expect };
