/**
 * API: Register Flow (Story 2.2 AC2)
 *
 * P0 — Critical path. Tests POST /api/auth/register end-to-end via HTTP
 * (route handler + usersRepo + JWT cookie + dashboardGuard).
 *
 * Integration-level: complements unit tests in tests/unit/authRegister.test.js
 * by exercising the full HTTP + cookie + status round-trip.
 */
import { test, expect } from '../support/merged-fixtures';
import { createUser } from '../support/factories';

test.describe('API: Register', () => {
  test('registers new user, sets JWT cookie, status reflects user role', async ({ apiRequest }) => {
    // Given: a fresh unique user
    const user = createUser();

    // When: registering
    const reg = await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { email: user.email, password: user.password, displayName: user.username },
    });

    // Then: success with userId + email
    expect(reg.status).toBe(200);
    const body = reg.body as { success: boolean; userId: string; email: string };
    expect(body.success).toBe(true);
    expect(body.email).toBe(user.email.toLowerCase());
    expect(body.userId).toBeTruthy();

    // And: auto-login — status returns role=user (cookie persisted in request context)
    const status = await apiRequest({ method: 'GET', path: '/api/auth/status' });
    expect(status.status).toBe(200);
    const statusBody = status.body as { role: string; email: string };
    expect(statusBody.role).toBe('user');
    expect(statusBody.email).toBe(user.email.toLowerCase());
  });

  test('rejects duplicate email with 409', async ({ apiRequest }) => {
    const user = createUser();

    const first = await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { email: user.email, password: user.password },
    });
    expect(first.status).toBe(200);

    // When: registering same email again
    const dup = await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { email: user.email, password: user.password },
    });

    // Then: conflict
    expect(dup.status).toBe(409);
  });

  test('rejects weak password (<8 chars) with 400', async ({ apiRequest }) => {
    const user = createUser();

    const res = await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { email: user.email, password: 'short' },
    });

    expect(res.status).toBe(400);
  });

  test('rejects missing email with 400', async ({ apiRequest }) => {
    const res = await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { password: 'ValidPassword123!' },
    });

    expect(res.status).toBe(400);
  });
});
