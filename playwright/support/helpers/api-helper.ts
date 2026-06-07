/**
 * API Helper
 *
 * Common API testing utilities for 9router.
 */
import { APIRequestContext, expect } from '@playwright/test';

/**
 * Assert response status and return parsed JSON body.
 */
export async function expectJsonResponse<T = unknown>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  url: string,
  options?: {
    data?: unknown;
    headers?: Record<string, string>;
    expectedStatus?: number;
  },
): Promise<T> {
  const { data, headers, expectedStatus = 200 } = options || {};

  const response = await request[method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch'](url, {
    ...(data ? { data } : {}),
    ...(headers ? { headers } : {}),
  });

  expect(response.status()).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

/**
 * Wait for API to be healthy before running tests.
 */
export async function waitForApiHealth(
  request: APIRequestContext,
  healthUrl = '/api/health',
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await request.get(healthUrl);
      if (response.ok()) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(`API health check failed after ${timeoutMs}ms`);
}
