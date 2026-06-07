/**
 * API: Forgot/Reset Password (Story 2.7 AC1/AC2)
 *
 * P1 — Account recovery, security-sensitive (anti-enumeration).
 */
import { test, expect } from '../support/merged-fixtures';
import { createUser } from '../support/factories';

test.describe('API: forgot-password (anti-enumeration)', () => {
  test('returns success for existing email', async ({ apiRequest }) => {
    const user = createUser();
    await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { email: user.email, password: user.password },
    });

    const res = await apiRequest({
      method: 'POST',
      path: '/api/auth/forgot-password',
      data: { email: user.email },
    });

    expect(res.status).toBe(200);
    expect((res.body as { success: boolean }).success).toBe(true);
  });

  test('returns success for non-existent email (no enumeration leak)', async ({ apiRequest }) => {
    const ghost = createUser();

    const res = await apiRequest({
      method: 'POST',
      path: '/api/auth/forgot-password',
      data: { email: ghost.email },
    });

    // Anti-enumeration: same success shape regardless of email existence
    expect(res.status).toBe(200);
    expect((res.body as { success: boolean }).success).toBe(true);
  });
});

test.describe('API: reset-password', () => {
  test('rejects invalid/expired token with 400', async ({ apiRequest }) => {
    const res = await apiRequest({
      method: 'POST',
      path: '/api/auth/reset-password',
      data: { token: 'invalid-token-deadbeef', newPassword: 'BrandNewPass123!' },
    });

    expect(res.status).toBe(400);
  });
});
