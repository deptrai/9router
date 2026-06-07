/**
 * API: Profile /api/users/me (Story 2.2 AC5)
 *
 * P1 — Protected resource + role guard. Tests GET/PATCH via HTTP.
 */
import { test, expect } from '../support/merged-fixtures';
import { createUser } from '../support/factories';

test.describe('API: users/me', () => {
  test('GET returns profile (no passwordHash) after register', async ({ apiRequest }) => {
    const user = createUser();
    await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { email: user.email, password: user.password, displayName: user.username },
    });

    const me = await apiRequest({ method: 'GET', path: '/api/users/me' });
    expect(me.status).toBe(200);

    const body = me.body as Record<string, unknown>;
    expect(body.email).toBe(user.email.toLowerCase());
    expect(body).not.toHaveProperty('passwordHash');
    expect(body).toHaveProperty('creditsBalance');
    expect(body).toHaveProperty('isEmailVerified');
  });

  test('PATCH updates displayName', async ({ apiRequest }) => {
    const user = createUser();
    await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { email: user.email, password: user.password },
    });

    const newName = `Updated_${user.username}`;
    const patch = await apiRequest({
      method: 'PATCH',
      path: '/api/users/me',
      data: { displayName: newName },
    });
    expect(patch.status).toBe(200);

    const me = await apiRequest({ method: 'GET', path: '/api/users/me' });
    const body = me.body as { displayName: string };
    expect(body.displayName).toBe(newName);
  });

  test('PATCH rejects wrong currentPassword with 401', async ({ apiRequest }) => {
    const user = createUser();
    await apiRequest({
      method: 'POST',
      path: '/api/auth/register',
      data: { email: user.email, password: user.password },
    });

    const patch = await apiRequest({
      method: 'PATCH',
      path: '/api/users/me',
      data: { currentPassword: 'WrongPassword999!', newPassword: 'BrandNewPass123!' },
    });

    expect(patch.status).toBe(401);
  });

  test('rejects unauthenticated access (no cookie) via dashboardGuard', async ({ request }) => {
    // Fresh request context without cookies — guard should block PROTECTED path
    const res = await request.get('/api/users/me');
    expect([401, 403, 302]).toContain(res.status());
  });
});
