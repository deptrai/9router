import { defineConfig, devices } from '@playwright/test';
import path from 'path';

/**
 * 9router E2E Test Configuration
 *
 * Environment switching: TEST_ENV=local|staging (default: local)
 * Base URL: env.BASE_URL || http://localhost:20128
 */

const baseURL = process.env.BASE_URL || 'http://localhost:20128';

export default defineConfig({
  testDir: path.resolve(__dirname, './playwright/e2e'),
  outputDir: path.resolve(__dirname, './test-results'),

  // Parallel execution
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // 1 retry locally absorbs Next.js dev-mode lazy-compile slowness on first
  // route hit under parallel load; CI uses 2. For fastest/most stable runs,
  // prefer a production build (npm run build && npm start) over dev server.
  retries: process.env.CI ? 2 : 1,
  // Cap local workers: the Next.js dev server is a single process that
  // compiles routes lazily, so too many parallel first-hits saturate CPU
  // and blow navigation timeouts. CI runs serial (1).
  workers: process.env.CI ? 1 : 3,

  // Global test timeout
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Reporters
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/results.xml' }],
    ['list'],
  ],

  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,

    // Artifacts
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    // Extra HTTP headers (API testing)
    extraHTTPHeaders: {
      Accept: 'application/json',
    },
  },

  // Browser projects
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'api',
      testMatch: /.*\.api\.spec\.ts/,
      use: {
        // No browser needed for API tests
      },
    },
  ],

  // Local dev server
  webServer: process.env.CI
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:20128',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
