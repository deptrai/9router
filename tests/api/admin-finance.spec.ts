import { test, expect } from '@playwright/test';

const API_URL = process.env.API_URL || 'http://localhost:3201';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

test.describe('Story 5.4: Admin Finance API Tests', () => {
  test('[P0] GET /api/admin/finance/summary succeeds with valid admin key', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/finance/summary`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary).toBeDefined();

    const s = body.summary;
    expect(typeof s.totalDepositsVnd).toBe('string');
    expect(typeof s.totalPurchasesVnd).toBe('string');
    expect(typeof s.totalRefundsVnd).toBe('string');
    expect(typeof s.totalWalletLiabilitiesVnd).toBe('string');
    expect(typeof s.reconciledDelta).toBe('string');
    expect(typeof s.isReconciled).toBe('boolean');
    expect(Array.isArray(s.anomalousTransactions)).toBe(true);
  });

  test('[P1] GET /api/admin/finance/summary rejects unauthenticated requests (401)', async ({ request }) => {
    const res1 = await request.get(`${API_URL}/api/admin/finance/summary`);
    expect(res1.status()).toBe(401);

    const res2 = await request.get(`${API_URL}/api/admin/finance/summary`, {
      headers: { 'x-admin-key': 'wrong-key' },
    });
    expect(res2.status()).toBe(401);
  });

  test('[P1] GET /api/admin/finance/summary validates date range (400)', async ({ request }) => {
    const res1 = await request.get(`${API_URL}/api/admin/finance/summary?from=invalid`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    expect(res1.status()).toBe(400);

    const res2 = await request.get(
      `${API_URL}/api/admin/finance/summary?from=2026-09-15&to=2026-09-01`,
      { headers: { 'x-admin-key': TEST_ADMIN_KEY } },
    );
    expect(res2.status()).toBe(400);
    const body = await res2.json();
    expect(body.errorCode).toBe('INVALID_DATE_RANGE');
  });

  test('[P0] GET /api/admin/finance/revenue returns time-series buckets', async ({ request }) => {
    const res = await request.get(
      `${API_URL}/api/admin/finance/revenue?granularity=daily&from=2026-09-01T00:00:00Z&to=2026-09-07T00:00:00Z`,
      { headers: { 'x-admin-key': TEST_ADMIN_KEY } },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.metrics)).toBe(true);
    expect(body.metrics.length).toBeGreaterThanOrEqual(7);

    const first = body.metrics[0];
    expect(typeof first.bucket).toBe('string');
    expect(typeof first.revenueVnd).toBe('string');
    expect(typeof first.costVnd).toBe('string');
    expect(typeof first.profitVnd).toBe('string');
    expect(typeof first.orderCount).toBe('number');
  });

  test('[P1] GET /api/admin/finance/revenue rejects invalid granularity (400)', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/finance/revenue?granularity=secondly`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('INVALID_GRANULARITY');
  });

  test('[P0] GET /api/admin/finance/ledger-check runs integrity validations', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/finance/ledger-check`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.integrity).toBeDefined();
    expect(typeof body.integrity.isClean).toBe('boolean');
    expect(Array.isArray(body.integrity.violations)).toBe(true);
  });
});
