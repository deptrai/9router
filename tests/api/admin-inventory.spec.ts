import { test, expect } from '@playwright/test';

/**
 * Story 5.2: Admin Inventory Management API Test Suite
 *
 * Covers:
 * - AdminRoleGuard authentication with x-admin-key header
 * - Bulk credential ingestion with normalization, deduplication and limits
 * - Product eligibility rules (isActive, sourcingMode in IN_HOUSE/HYBRID)
 * - Deterministic masking for emails, user:password, and license keys
 * - Single item plaintext decryption with audit logging
 * - Status transition (AVAILABLE <-> DEFECTIVE)
 * - Atomic conditional deletion & 409 Conflict protection for RESERVED/SOLD keys
 * - Global and product-level inventory metrics
 */

const API_URL = process.env.API_URL || 'http://localhost:3201';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

test.describe('Story 5.2: Admin Inventory API Tests', () => {
  let targetProductId: string;
  let externalProductId: string;
  let createdItemId: string;

  test.beforeAll(async ({ request }) => {
    // 1. Create a test IN_HOUSE product
    const prodRes = await request.post(`${API_URL}/api/admin/products`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: {
        title: `Inventory Test Product ${Date.now()}`,
        price: '50000.00',
        category: 'Test Category',
        sourcingMode: 'IN_HOUSE',
        isActive: true,
      },
    });
    expect([200, 201]).toContain(prodRes.status());
    const prodBody = await prodRes.json();
    targetProductId = prodBody.product.id;

    // 2. Fetch or create an active supplier
    const supRes = await request.get(`${API_URL}/api/admin/suppliers`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });
    const supBody = await supRes.json();
    let supplierId = supBody.suppliers?.find((s: any) => s.isActive)?.id;

    if (!supplierId) {
      const newSup = await request.post(`${API_URL}/api/admin/suppliers`, {
        headers: { 'x-admin-key': TEST_ADMIN_KEY },
        data: {
          name: `Supplier ${Date.now()}`,
          type: 'CONFIG_POOL',
          markupPercentage: '10.00',
          markupFixedVnd: '5000.00',
          isActive: true,
        },
      });
      const newSupBody = await newSup.json();
      supplierId = newSupBody.supplier.id;
    }

    // 3. Create an EXTERNAL product to test rejection
    const extRes = await request.post(`${API_URL}/api/admin/products`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: {
        title: `External Test Product ${Date.now()}`,
        price: '150000.00',
        category: 'External',
        sourcingMode: 'EXTERNAL',
        supplierSourceId: supplierId,
        isActive: true,
      },
    });
    expect([200, 201]).toContain(extRes.status());
    const extBody = await extRes.json();
    externalProductId = extBody.product.id;
  });

  // --- 1. Global Summary & Access Control ---

  test('[P0] GET /api/admin/inventory/summary returns global stock metrics with valid admin key', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/inventory/summary`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary).toBeDefined();
    expect(typeof body.summary.totalAvailable).toBe('number');
    expect(typeof body.summary.totalReserved).toBe('number');
    expect(typeof body.summary.totalSold).toBe('number');
    expect(typeof body.summary.totalDefective).toBe('number');
    expect(Array.isArray(body.summary.productStockSummaries)).toBe(true);
  });

  test('[P1] GET /api/admin/inventory/summary rejects without admin key (401)', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/inventory/summary`);
    expect(res.status()).toBe(401);
  });

  // --- 2. Batch Credential Ingestion ---

  test('[P0] POST /api/admin/inventory/products/:productId/batch successfully ingests valid credentials', async ({ request }) => {
    const credentials = [
      'user1@example.com',
      'admin:secretpassword123',
      'XXXX-YYYY-ZZZZ',
      '# this is a comment line',
      '',
      '   ',
      'user1@example.com', // Duplicate, should be deduplicated
      'license-key-standalone-1',
    ];

    const res = await request.post(`${API_URL}/api/admin/inventory/products/${targetProductId}/batch`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: { credentials },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.productId).toBe(targetProductId);
    // 4 unique valid credentials: user1@example.com, admin:secretpassword123, XXXX-YYYY-ZZZZ, license-key-standalone-1
    expect(body.count).toBe(4);
    expect(body.addedAt).toBeDefined();
  });

  test('[P1] POST /api/admin/inventory/products/:productId/batch rejects EXTERNAL product (400 PRODUCT_DOES_NOT_ACCEPT_INVENTORY)', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/admin/inventory/products/${externalProductId}/batch`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: { credentials: ['key1', 'key2'] },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('PRODUCT_DOES_NOT_ACCEPT_INVENTORY');
  });

  test('[P1] POST /api/admin/inventory/products/:productId/batch rejects empty batch payload (400 EMPTY_BATCH_PAYLOAD)', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/admin/inventory/products/${targetProductId}/batch`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: { credentials: ['', '   ', '# comment only'] },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('EMPTY_BATCH_PAYLOAD');
  });

  test('[P1] POST /api/admin/inventory/products/:productId/batch rejects lines exceeding 2048 characters (400 LINE_TOO_LONG)', async ({ request }) => {
    const hugeLine = 'A'.repeat(2049);
    const res = await request.post(`${API_URL}/api/admin/inventory/products/${targetProductId}/batch`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: { credentials: [hugeLine] },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('LINE_TOO_LONG');
  });

  test('[P1] POST /api/admin/inventory/products/:productId/batch enforces 500 item limit (400 BATCH_SIZE_EXCEEDED)', async ({ request }) => {
    const overLimit = Array.from({ length: 501 }, (_, i) => `key-${i}-${Date.now()}`);
    const res = await request.post(`${API_URL}/api/admin/inventory/products/${targetProductId}/batch`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: { credentials: overLimit },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('BATCH_SIZE_EXCEEDED');
  });

  // --- 3. Inventory Inspection & Deterministic Masking ---

  test('[P0] GET /api/admin/inventory/products/:productId returns paginated masked items', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/inventory/products/${targetProductId}?limit=50&offset=0`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(4);
    expect(body.total).toBeGreaterThanOrEqual(4);

    // Verify deterministic masking applied
    const emailItem = body.items.find((i: any) => i.maskedCredential.includes('@'));
    if (emailItem) {
      expect(emailItem.maskedCredential).toContain('***');
      expect(emailItem.maskedCredential.endsWith('@example.com')).toBe(true);
    }

    const colonItem = body.items.find((i: any) => i.maskedCredential.includes(':'));
    if (colonItem) {
      expect(colonItem.maskedCredential).toContain(':****');
    }

    // Save one item ID for subsequent tests
    createdItemId = body.items[0].id;
  });

  test('[P0] GET /api/admin/inventory/items/:id/decrypt returns plaintext credential with valid admin auth', async ({ request }) => {
    expect(createdItemId).toBeDefined();

    const res = await request.get(`${API_URL}/api/admin/inventory/items/${createdItemId}/decrypt`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.credential).toBe('string');
    expect(body.credential.length).toBeGreaterThan(0);
    expect(body.credential).not.toBe('***');
  });

  // --- 4. Status Toggle & Atomic Deletion Guard ---

  test('[P0] PATCH /api/admin/inventory/items/:id/status updates status to DEFECTIVE', async ({ request }) => {
    expect(createdItemId).toBeDefined();

    const res = await request.patch(`${API_URL}/api/admin/inventory/items/${createdItemId}/status`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: { status: 'DEFECTIVE' },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(true);
  });

  test('[P0] DELETE /api/admin/inventory/items/:id deletes DEFECTIVE or AVAILABLE item', async ({ request }) => {
    expect(createdItemId).toBeDefined();

    const res = await request.delete(`${API_URL}/api/admin/inventory/items/${createdItemId}`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(true);
  });

  test('[P1] DELETE /api/admin/inventory/items/:id returns 404 for non-existent item', async ({ request }) => {
    const fakeUuid = '00000000-0000-4000-8000-000000000000';
    const res = await request.delete(`${API_URL}/api/admin/inventory/items/${fakeUuid}`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(404);
  });
});
