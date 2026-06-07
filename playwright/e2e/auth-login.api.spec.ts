/**
 * API: Login Flow (Story 2.2 AC3)
 *
 * P0 — Critical auth. Tests POST /api/auth/login (user branch) via HTTP.
 * Each test seeds its own user via register to stay parallel-safe.
 */
import { test, expect } from '../support/merged-fixtures';
import { createUser } from '../support/factories';

test.describe('API: Login (user branch)', () => {
  test('logs in with correct email + password', async ({ apiRequest }) => {
    // Given: a registered user
    const user = createUser();
    await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { email: user.email, password: user.password },
    });

    // When: logging in
    const login = await apiRequest({
      method: 'POST',
      path: '/api/auth/login',
      data: { email: user.email, password: user.password },
    });

    // Then: success
    expect(login.status).toBe(200);

    // And: status confirms user session
    const status = await apiRequest({ method: 'GET', path: '/api/auth/status' });
    const statusBody = status.body as { role: string; email: string };
    expect(statusBody.role).toBe('user');
    expect(statusBody.email).toBe(user.email.toLowerCase());
  });

  test('rejects wrong password with 401', async ({ apiRequest }) => {
    const user = createUser();
    await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { email: user.email, password: user.password },
    });

    const login = await apiRequest({
      method: 'POST',
      path: '/api/auth/login',
      data: { email: user.email, password: 'WrongPassword999!' },
    });

    expect(login.status).toBe(401);
  });

  test('rejects unknown email with 401', async ({ apiRequest }) => {
    const user = createUser();

    const login = await apiRequest({
      method: 'POST',
      path: '/api/auth/login',
      data: { email: user.email, password: user.password },
    });

    expect(login.status).toBe(401);
  });
});
