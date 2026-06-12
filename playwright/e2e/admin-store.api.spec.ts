/**
 * API: Admin Store — Product / Inventory / Order Management (Story 2.28)
 *
 * P0 — Admin CRUD surface for the Telegram Store. Tests the /api/store/admin/*
 * endpoints over HTTP. Story 2.28 has NO dashboard UI page — its entire surface
 * is API + Telegram bot, so browser-level verification == these API specs.
 *
 * Auth (AC9): requireAdmin() denies requests without a valid admin session
 * (src/lib/auth/requireRole.js → 403). The apiRequest fixture carries an admin
 * auth_token cookie, so AC1–AC8 exercise the authenticated CRUD surface. The
 * AC9 describe block below uses the raw `request` fixture (no cookie) to assert
 * the unauthenticated path is rejected with 403.
 *
 * Each test creates its own product and cleans it up to stay parallel-safe.
 */
import { test, expect } from '../support/merged-fixtures';

type Product = { id: string; name: string; kind: string; priceCredits: number; isActive?: boolean };

function uniqueName(prefix: string): string {
  // No Date.now()/Math.random() restriction here (test runtime), but keep it
  // collision-resistant across parallel workers.
  return `${prefix}-${process.pid}-${test.info().workerIndex}-${test.info().testId}`;
}

test.describe('API: Admin Store — products CRUD (AC1)', () => {
  test('POST creates a product → 201 with product object, no payload leak', async ({ apiRequest }) => {
    const res = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: {
        name: uniqueName('e2e-prod'),
        kind: 'credential',
        priceCredits: 100,
        deliveryMode: 'instant',
      },
    });

    expect(res.status).toBe(201);
    const body = res.body as { product: Product };
    expect(body.product).toBeTruthy();
    expect(body.product.id).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/payload|ciphertext|payloadEnc/i);

    // cleanup
    await apiRequest({ method: 'DELETE', path: `/api/store/admin/products/${body.product.id}` });
  });

  test('POST rejects invalid kind → 422', async ({ apiRequest }) => {
    const res = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: { name: uniqueName('bad-kind'), kind: 'not_a_kind', priceCredits: 50, deliveryMode: 'instant' },
    });
    expect(res.status).toBe(422);
  });

  test('POST rejects missing name → 422', async ({ apiRequest }) => {
    const res = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: { kind: 'credential', priceCredits: 50, deliveryMode: 'instant' },
    });
    expect(res.status).toBe(422);
  });

  test('POST rejects negative priceCredits → 422', async ({ apiRequest }) => {
    const res = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: { name: uniqueName('neg-price'), kind: 'credential', priceCredits: -5, deliveryMode: 'instant' },
    });
    expect(res.status).toBe(422);
  });

  test('GET list returns products array', async ({ apiRequest }) => {
    const res = await apiRequest({ method: 'GET', path: '/api/store/admin/products' });
    expect(res.status).toBe(200);
    const body = res.body as { products: Product[] };
    expect(Array.isArray(body.products)).toBe(true);
  });

  test('GET by id → 200 for existing, 404 for missing', async ({ apiRequest }) => {
    const created = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: { name: uniqueName('getbyid'), kind: 'credential', priceCredits: 10, deliveryMode: 'instant' },
    });
    const id = (created.body as { product: Product }).product.id;

    const ok = await apiRequest({ method: 'GET', path: `/api/store/admin/products/${id}` });
    expect(ok.status).toBe(200);

    const missing = await apiRequest({ method: 'GET', path: '/api/store/admin/products/nonexistent-id-xyz' });
    expect(missing.status).toBe(404);

    await apiRequest({ method: 'DELETE', path: `/api/store/admin/products/${id}` });
  });

  test('PATCH updates fields (isActive toggle)', async ({ apiRequest }) => {
    const created = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: { name: uniqueName('patch'), kind: 'credential', priceCredits: 10, deliveryMode: 'instant' },
    });
    const id = (created.body as { product: Product }).product.id;

    const patch = await apiRequest({
      method: 'PATCH',
      path: `/api/store/admin/products/${id}`,
      data: { isActive: false, priceCredits: 999 },
    });
    expect(patch.status).toBe(200);
    const body = patch.body as { product: Product };
    expect(body.product.priceCredits).toBe(999);

    await apiRequest({ method: 'DELETE', path: `/api/store/admin/products/${id}` });
  });

  test('DELETE product with no orders → 200, then 404 on re-GET', async ({ apiRequest }) => {
    const created = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: { name: uniqueName('del'), kind: 'credential', priceCredits: 10, deliveryMode: 'instant' },
    });
    const id = (created.body as { product: Product }).product.id;

    const del = await apiRequest({ method: 'DELETE', path: `/api/store/admin/products/${id}` });
    expect(del.status).toBe(200);

    const after = await apiRequest({ method: 'GET', path: `/api/store/admin/products/${id}` });
    expect(after.status).toBe(404);
  });
});

test.describe('API: Admin Store — orders list (AC2)', () => {
  test('GET orders returns pagination metadata', async ({ apiRequest }) => {
    const res = await apiRequest({ method: 'GET', path: '/api/store/admin/orders?limit=20&offset=0' });
    expect(res.status).toBe(200);
    const body = res.body as { orders: unknown[]; total: number; limit: number; offset: number };
    expect(Array.isArray(body.orders)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
    expect(JSON.stringify(body)).not.toMatch(/payload|ciphertext|payloadEnc/i);
  });

  test('GET orders with valid status filter → 200', async ({ apiRequest }) => {
    const res = await apiRequest({ method: 'GET', path: '/api/store/admin/orders?status=paid' });
    expect(res.status).toBe(200);
  });

  test('GET orders with invalid status → 422', async ({ apiRequest }) => {
    const res = await apiRequest({ method: 'GET', path: '/api/store/admin/orders?status=bogus' });
    expect(res.status).toBe(422);
  });

  test('GET order by id → 404 for missing', async ({ apiRequest }) => {
    const res = await apiRequest({ method: 'GET', path: '/api/store/admin/orders/nonexistent-order-xyz' });
    expect(res.status).toBe(404);
  });

  test('PATCH order rejects invalid action → 422', async ({ apiRequest }) => {
    const res = await apiRequest({
      method: 'PATCH',
      path: '/api/store/admin/orders/some-id',
      data: { action: 'frobnicate' },
    });
    expect(res.status).toBe(422);
  });
});

test.describe('API: Admin Store — inventory (AC5, NFR8)', () => {
  test('POST credentials rejects empty array → 422', async ({ apiRequest }) => {
    const created = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: { name: uniqueName('inv-empty'), kind: 'credential', priceCredits: 10, deliveryMode: 'instant' },
    });
    const id = (created.body as { product: Product }).product.id;

    const res = await apiRequest({
      method: 'POST',
      path: `/api/store/admin/products/${id}/credentials`,
      data: { items: [] },
    });
    expect(res.status).toBe(422);

    await apiRequest({ method: 'DELETE', path: `/api/store/admin/products/${id}` });
  });

  test('POST credentials rejects > 500 items → 422', async ({ apiRequest }) => {
    const created = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: { name: uniqueName('inv-max'), kind: 'credential', priceCredits: 10, deliveryMode: 'instant' },
    });
    const id = (created.body as { product: Product }).product.id;

    const items = Array.from({ length: 501 }, (_, i) => ({ payload: `secret-${i}` }));
    const res = await apiRequest({
      method: 'POST',
      path: `/api/store/admin/products/${id}/credentials`,
      data: { items },
    });
    expect(res.status).toBe(422);

    await apiRequest({ method: 'DELETE', path: `/api/store/admin/products/${id}` });
  });

  test('POST credentials adds inventory; GET list never echoes payload (NFR8)', async ({ apiRequest }) => {
    const created = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: { name: uniqueName('inv-add'), kind: 'credential', priceCredits: 10, deliveryMode: 'instant' },
    });
    const id = (created.body as { product: Product }).product.id;

    const secret = 'super-secret-payload-DO-NOT-LEAK';
    const add = await apiRequest({
      method: 'POST',
      path: `/api/store/admin/products/${id}/credentials`,
      data: { items: [{ payload: secret }, { payload: secret + '-2' }] },
    });
    expect(add.status).toBe(201);
    const addBody = add.body as { added: number; failed: number };
    expect(addBody.added).toBe(2);
    expect(JSON.stringify(add.body)).not.toContain(secret);

    const list = await apiRequest({
      method: 'GET',
      path: `/api/store/admin/products/${id}/credentials?status=available`,
    });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(JSON.stringify(list.body)).not.toMatch(/payloadEnc|ciphertext/i);

    // cleanup: product still has no orders, so delete cascades inventory
    await apiRequest({ method: 'DELETE', path: `/api/store/admin/products/${id}` });
  });

  test('GET credentials rejects invalid status filter → 422', async ({ apiRequest }) => {
    const created = await apiRequest({
      method: 'POST',
      path: '/api/store/admin/products',
      data: { name: uniqueName('inv-badstatus'), kind: 'credential', priceCredits: 10, deliveryMode: 'instant' },
    });
    const id = (created.body as { product: Product }).product.id;

    const res = await apiRequest({
      method: 'GET',
      path: `/api/store/admin/products/${id}/credentials?status=bogus`,
    });
    expect(res.status).toBe(422);

    await apiRequest({ method: 'DELETE', path: `/api/store/admin/products/${id}` });
  });
});

test.describe('API: Admin Store — auth guard (AC9)', () => {
  // These requests carry NO auth cookie (raw request fixture).
  // requireAdmin() denies sessionless requests, so AC9 asserts 403.
  test('unauthenticated GET products should be 403 (AC9)', async ({ request }) => {
    const res = await request.get('/api/store/admin/products');
    expect(res.status()).toBe(403);
  });

  test('unauthenticated GET orders should be 403 (AC9)', async ({ request }) => {
    const res = await request.get('/api/store/admin/orders');
    expect(res.status()).toBe(403);
  });
});
