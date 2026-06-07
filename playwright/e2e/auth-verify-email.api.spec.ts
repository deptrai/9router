/**
 * API: Verify Email (Story 2.6 AC4)
 *
 * P1 — Token one-time-use. Tests GET /api/auth/verify-email.
 * Note: valid-token path requires capturing the token (email is fail-soft
 * skipped in test env without RESEND_API_KEY), so we cover the negative
 * paths which are deterministic and security-critical.
 */
import { test, expect } from '../support/merged-fixtures';

test.describe('API: verify-email', () => {
  test('rejects missing token with 400', async ({ apiRequest }) => {
    const res = await apiRequest({ method: 'GET', path: '/api/auth/verify-email' });
    expect(res.status).toBe(400);
  });

  test('rejects invalid token with 400', async ({ apiRequest }) => {
    const res = await apiRequest({
      method: 'GET',
      path: '/api/auth/verify-email?token=invalid-deadbeef-token',
    });
    expect(res.status).toBe(400);
  });
});
