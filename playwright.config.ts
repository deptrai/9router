import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { loadEnvConfig } from '@next/env';

/**
 * 9router E2E Test Configuration
 *
 * Environment switching: TEST_ENV=local|staging (default: local)
 * Base URL: env.BASE_URL || http://localhost:20128
 */

// Load .env / .env.local the SAME way Next.js does so the test process resolves
// the identical DATA_DIR (and thus the same jwt-secret file) as the running
// server. Without this, admin-token.ts falls back to ~/.9router/jwt-secret while
// the server signs with <DATA_DIR>/jwt-secret → JWT signature mismatch → 401.
loadEnvConfig(__dirname);

// loadEnvConfig above also pulls BASE_URL from .env — which points at the REMOTE
// deployment (https://router.chainlens.net). The apiRequest fixture issues
// relative paths resolved against baseURL, so a remote BASE_URL silently routes
// admin calls to the remote server, which signs JWTs with a different secret →
// 401. API tests must target the LOCAL dev server (started by the webServer
// block) unless explicitly switched to staging via TEST_ENV=staging.
const TEST_ENV = process.env.TEST_ENV || 'local';
if (TEST_ENV === 'local') {
  process.env.BASE_URL = 'http://localhost:20128';
}

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
