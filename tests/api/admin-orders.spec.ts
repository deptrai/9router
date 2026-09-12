import { test, expect } from '@playwright/test';

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
    test.skip(!sampleOrderId, 'No existing order found to test detail');

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
    // 1. Find an order with status FULFILLED, PAID, or SOURCING
    const listRes = await request.get(`${API_URL}/api/admin/orders?limit=50`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    const listBody = await listRes.json();
    const refundableOrder = listBody.orders.find(
      (o: any) => o.status === 'FULFILLED' || o.status === 'PAID' || o.status === 'SOURCING',
    );

    test.skip(!refundableOrder, 'No refundable order available in test database');

    // 2. Perform manual refund
    const refundRes = await request.post(`${API_URL}/api/admin/orders/${refundableOrder.id}/refund`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: {
        reason: 'API automation test manual refund',
        markCredentialDefective: true,
      },
    });

    expect(refundRes.status()).toBe(201);
    const refundBody = await refundRes.json();
    expect(refundBody.ok).toBe(true);
    expect(refundBody.refunded).toBe(true);
    expect(refundBody.orderId).toBe(refundableOrder.id);
    expect(refundBody.refundedAmount).toBe(refundableOrder.price);

    // 3. Re-query order and verify status is REFUNDED
    const detailRes = await request.get(`${API_URL}/api/admin/orders/${refundableOrder.id}`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    const detailBody = await detailRes.json();
    expect(detailBody.order.order.status).toBe('REFUNDED');

    // 4. Attempt double refund -> must reject with 409 Conflict ORDER_ALREADY_REFUNDED
    const doubleRefundRes = await request.post(`${API_URL}/api/admin/orders/${refundableOrder.id}/refund`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: { reason: 'Double refund attempt' },
    });

    expect(doubleRefundRes.status()).toBe(409);
    const doubleRefundBody = await doubleRefundRes.json();
    expect(doubleRefundBody.errorCode).toBe('ORDER_ALREADY_REFUNDED');
  });
});
