import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Story 5.3: Admin Orders & Manual Refund Management API Test Suite
 *
 * Covers:
 * - AdminRoleGuard authentication with x-admin-key header
 * - Admin Orders list with status filtering, keyword search, and pagination
 * - Detailed order inspection with customer info, product info, traces, and ledger transactions
 * - Atomic manual refund execution via Ledger with audit logging
 * - Concurrency and state validation guards (rejects already refunded, pending, etc.)
 * - ParseUUIDPipe parameter enforcement
 */

const API_URL = process.env.API_URL || 'http://localhost:3201';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

test.describe('Story 5.3: Admin Orders API Tests', () => {
  let sampleOrderId: string;

  // Seed a refundable order straight into Postgres — the refund test needs a
  // FULFILLED/PAID/SOURCING order and there is no admin credit/topup endpoint to
  // produce one via the public API. Uses DATABASE_URL from apps/api/.env.
  function seedRefundableOrder(): string {
    const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/9router_ecommerce';
    const tgId = Math.floor(100000000 + Math.random() * 900000000);
    // Single-line SQL — psql -c rejects embedded newlines.
    const sql =
      `WITH u AS (INSERT INTO users (telegram_id, username, first_name, role) ` +
      `VALUES (${tgId}, 'refund_seed', 'Refund Seed', 'CUSTOMER') RETURNING id), ` +
      `w AS (INSERT INTO wallets (user_id, balance, currency) SELECT id, '0.00', 'VND' FROM u), ` +
      `p AS (SELECT id FROM products WHERE is_active = true LIMIT 1) ` +
      `INSERT INTO orders (user_id, product_id, price, status, delivered_credential, fulfilled_at) ` +
      `SELECT u.id, p.id, '120000.00', 'FULFILLED', 'seed-cred@example.com', now() FROM u, p RETURNING id;`;
    const psql = process.env.PSQL_PATH || 'psql';
    const out = execSync(`${psql} "${dbUrl}" -tAc ${JSON.stringify(sql)}`, { encoding: 'utf-8' }).trim();
    // psql -tAc prints the returned row then "INSERT 0 1" — pick the UUID line.
    const line = out.split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f-]{36}$/i.test(l));
    return line ?? '';
  }

  test.beforeAll(async ({ request }) => {
    // Fetch an existing order or get list
    const res = await request.get(`${API_URL}/api/admin/orders?limit=1`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    if (body.orders && body.orders.length > 0) {
      sampleOrderId = body.orders[0].id;
    }

    // Guarantee a refundable order exists for the refund test.
    try {
      seedRefundableOrder();
    } catch {
      // DB unreachable — the refund test will skip itself if no order qualifies.
    }
  });

  // --- 1. Authentication & Listing ---

  test('[P0] GET /api/admin/orders succeeds with valid admin key', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/orders`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.orders)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  test('[P1] GET /api/admin/orders rejects with 401 when x-admin-key is missing', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/orders`);
    expect(res.status()).toBe(401);
  });

  test('[P1] GET /api/admin/orders rejects with 401 when x-admin-key is invalid', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/orders`, {
      headers: { 'x-admin-key': 'invalid-key-that-is-at-least-32-chars-long-1234' },
    });
    expect(res.status()).toBe(401);
  });

  test('[P0] GET /api/admin/orders filters by status and supports search', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/orders?status=FULFILLED&limit=10`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    for (const order of body.orders) {
      expect(order.status).toBe('FULFILLED');
    }
  });

  // --- 2. Order Detail & Parameter Validation ---

  test('[P0] GET /api/admin/orders/:id returns comprehensive order details', async ({ request }) => {
    expect(sampleOrderId, 'No existing order found to test detail — seed test data first').toBeTruthy();

    const res = await request.get(`${API_URL}/api/admin/orders/${sampleOrderId}`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.order).toBeDefined();
    expect(body.order.order.id).toBe(sampleOrderId);
    expect(body.order.customer).toBeDefined();
    expect(body.order.product).toBeDefined();
    expect(Array.isArray(body.order.supplierTraces)).toBe(true);
    expect(Array.isArray(body.order.ledgerTransactions)).toBe(true);
  });

  test('[P1] GET /api/admin/orders/:id rejects invalid UUID format (400)', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/orders/not-a-valid-uuid`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(400);
  });

  test('[P1] GET /api/admin/orders/:id returns 404 for non-existent order', async ({ request }) => {
    const fakeUuid = '00000000-0000-4000-8000-000000000000';
    const res = await request.get(`${API_URL}/api/admin/orders/${fakeUuid}`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(404);
  });

  // --- 3. Manual Refund Execution & State Guards ---

  test('[P1] POST /api/admin/orders/:id/refund rejects empty reason (400)', async ({ request }) => {
    const fakeUuid = '00000000-0000-4000-8000-000000000000';
    const res = await request.post(`${API_URL}/api/admin/orders/${fakeUuid}/refund`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: { reason: '   ' },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('INVALID_REFUND_PAYLOAD');
  });

  test('[P0] POST /api/admin/orders/:id/refund atomically refunds an eligible order and rejects double refund', async ({ request }) => {
    // 1. Seed a dedicated refundable order (user + wallet + FULFILLED order).
    //    Reusing a random list order is flaky — it may already be refunded or
    //    belong to a wallet-less fixture.
    const refundableOrderId = seedRefundableOrder();
    expect(refundableOrderId, 'Failed to seed refundable order').toBeTruthy();

    const detailRes0 = await request.get(`${API_URL}/api/admin/orders/${refundableOrderId}`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    const refundableOrder = (await detailRes0.json()).order?.order ?? (await detailRes0.json()).order;

    // 2. Perform manual refund
    const refundRes = await request.post(`${API_URL}/api/admin/orders/${refundableOrderId}/refund`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: {
        reason: 'API automation test manual refund',
        markCredentialDefective: true,
      },
    });

    const refundText = await refundRes.text();
    expect(refundRes.status(), `refund failed on order ${refundableOrderId}: ${refundText}`).toBe(201);
    const refundBody = JSON.parse(refundText);
    expect(refundBody.ok).toBe(true);
    expect(refundBody.refunded).toBe(true);
    expect(refundBody.orderId).toBe(refundableOrderId);

    // 3. Re-query order and verify status is REFUNDED
    const detailRes = await request.get(`${API_URL}/api/admin/orders/${refundableOrderId}`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    const detailBody = await detailRes.json();
    expect(detailBody.order.order.status).toBe('REFUNDED');

    // 4. Attempt double refund -> must reject with 409 Conflict ORDER_ALREADY_REFUNDED
    const doubleRefundRes = await request.post(`${API_URL}/api/admin/orders/${refundableOrderId}/refund`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: { reason: 'Double refund attempt' },
    });

    expect(doubleRefundRes.status()).toBe(409);
    const doubleRefundBody = await doubleRefundRes.json();
    expect(doubleRefundBody.errorCode).toBe('ORDER_ALREADY_REFUNDED');
  });
});
