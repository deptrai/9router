import { test, expect } from '@playwright/test';

const API_URL = process.env.API_URL || 'http://localhost:3201';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

test.describe('Epic 4 Retro: Admin Ops Monitoring API Tests', () => {

  // ── Auth guard ────────────────────────────────────────────────────────────

  test('[P1] GET /api/admin/ops/metrics rejects unauthenticated requests (401)', async ({ request }) => {
    const res1 = await request.get(`${API_URL}/api/admin/ops/metrics`);
    expect(res1.status()).toBe(401);

    const res2 = await request.get(`${API_URL}/api/admin/ops/metrics`, {
      headers: { 'x-admin-key': 'wrong-key' },
    });
    expect(res2.status()).toBe(401);
  });

  test('[P1] GET /api/admin/ops/failed-jobs rejects unauthenticated requests (401)', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/ops/failed-jobs`);
    expect(res.status()).toBe(401);
  });

  test('[P1] POST /api/admin/ops/failed-jobs/:jobId/retry rejects unauthenticated (401)', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/admin/ops/failed-jobs/some-job-id/retry`);
    expect(res.status()).toBe(401);
  });

  // ── Metrics ───────────────────────────────────────────────────────────────

  test('[P0] GET /api/admin/ops/metrics returns ops metrics shape', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/ops/metrics`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.metrics).toBeDefined();

    const m = body.metrics;
    expect(typeof m.timeoutRatePct).toBe('number');
    expect(m.timeoutRatePct).toBeGreaterThanOrEqual(0);
    expect(m.timeoutRatePct).toBeLessThanOrEqual(100);
    expect(typeof m.sweeperRescueCount).toBe('number');
    expect(typeof m.totalAttempts).toBe('number');
    expect(typeof m.failedJobCount).toBe('number');
    expect(m.avgSourcingLatencyMs === null || typeof m.avgSourcingLatencyMs === 'number').toBe(true);
    expect(Array.isArray(m.perSupplier)).toBe(true);
  });

  test('[P0] GET /api/admin/ops/metrics perSupplier entries have correct shape', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/ops/metrics`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    expect(res.status()).toBe(200);
    const { metrics } = await res.json();

    for (const s of metrics.perSupplier) {
      // Assert non-empty values, not just types
      expect(s.supplierName).toBeTruthy();
      expect(s.successCount + s.failCount).toBeGreaterThanOrEqual(0);
      expect(s.avgLatencyMs === null || s.avgLatencyMs >= 0).toBe(true);
      expect(s.timeoutCount).toBeGreaterThanOrEqual(0);
    }
  });

  test('[P1] GET /api/admin/ops/metrics accepts valid windowHours param', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/ops/metrics?windowHours=1`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.metrics).toBeDefined();
  });

  test('[P1] GET /api/admin/ops/metrics rejects non-positive windowHours (400)', async ({ request }) => {
    const res1 = await request.get(`${API_URL}/api/admin/ops/metrics?windowHours=0`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    expect(res1.status()).toBe(400);

    const res2 = await request.get(`${API_URL}/api/admin/ops/metrics?windowHours=-5`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    expect(res2.status()).toBe(400);
  });

  test('[P1] GET /api/admin/ops/metrics rejects non-integer windowHours (400)', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/ops/metrics?windowHours=abc`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    expect(res.status()).toBe(400);
  });

  // ── Failed jobs ───────────────────────────────────────────────────────────

  test('[P0] GET /api/admin/ops/failed-jobs returns jobs array', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/ops/failed-jobs`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.jobs)).toBe(true);

    for (const job of body.jobs) {
      expect(typeof job.jobId).toBe('string');
      expect(typeof job.orderId).toBe('string');
      expect(typeof job.failedReason).toBe('string');
      expect(typeof job.attemptsMade).toBe('number');
      expect(typeof job.failedAt).toBe('string');
      // ISO 8601 check
      expect(Number.isNaN(Date.parse(job.failedAt))).toBe(false);
    }
  });

  test('[P1] GET /api/admin/ops/failed-jobs accepts limit param', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/ops/failed-jobs?limit=5`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    expect(res.status()).toBe(200);
    const { jobs } = await res.json();
    expect(jobs.length).toBeLessThanOrEqual(5);
  });

  // ── Retry ─────────────────────────────────────────────────────────────────

  test('[P1] POST /api/admin/ops/failed-jobs/:jobId/retry returns 404 for unknown job', async ({ request }) => {
    const res = await request.post(
      `${API_URL}/api/admin/ops/failed-jobs/nonexistent-job-id-xyz/retry`,
      { headers: { 'x-admin-key': TEST_ADMIN_KEY } },
    );

    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.errorCode).toBe('JOB_NOT_FOUND');
  });

  test('[P1] POST /api/admin/ops/failed-jobs/:jobId/retry returns 400 for empty jobId', async ({ request }) => {
    // %20 encodes space — trims to empty
    const res = await request.post(
      `${API_URL}/api/admin/ops/failed-jobs/%20/retry`,
      { headers: { 'x-admin-key': TEST_ADMIN_KEY } },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('INVALID_JOB_ID');
  });
});
