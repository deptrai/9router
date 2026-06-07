/**
 * Auth Helper
 *
 * Utilities for authenticating test users against 9router.
 */
import { APIRequestContext } from '@playwright/test';

export type AuthTokens = {
  accessToken: string;
  refreshToken?: string;
};

/**
 * Login via API and return JWT tokens.
 */
export async function loginViaApi(
  request: APIRequestContext,
  credentials: { email: string; password: string },
): Promise<AuthTokens> {
  const response = await request.post('/api/auth/login', {
    data: credentials,
  });

  if (!response.ok()) {
    throw new Error(`Login failed: ${response.status()} ${await response.text()}`);
  }

  const body = await response.json();
  return {
    accessToken: body.token || body.accessToken,
    refreshToken: body.refreshToken,
  };
}

/**
 * Get auth headers for authenticated API requests.
 */
export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}
