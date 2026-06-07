/**
 * API Health Check Tests
 *
 * Verifies the 9router API is responding correctly.
 */
import { test, expect } from '../support/merged-fixtures';

test.describe('API Health', () => {
  test('GET /api/health returns 200', async ({ apiRequest }) => {
    const { status } = await apiRequest({
      method: 'GET',
      path: '/api/health',
    });

    expect(status).toBe(200);
  });
});
