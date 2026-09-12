import { test, expect } from '@playwright/test';

/**
 * Story 5.1: Admin Product Catalog & Supplier Management API Test Suite
 *
 * Covers:
 * - AdminRoleGuard authentication with x-admin-key header
 * - Admin Products CRUD operations and validation rules
 * - Supplier Source CRUD operations and active product integrity guards
 * - Server-side pagination and search filters
 */

const API_URL = process.env.API_URL || 'http://localhost:3201';
const TEST_ADMIN_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

test.describe('Admin Catalog & Supplier API Tests', () => {
  let createdProductId: string | null = null;
  let createdSupplierId: string | null = null;

  // --- Authentication & Access Control ---

  test('[P0] GET /api/admin/products succeeds with valid x-admin-key', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/products`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.products)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  test('[P1] GET /api/admin/products rejects with 401 when x-admin-key is missing', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/products`);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.errorCode).toBe('AUTH_UNAUTHORIZED');
  });

  test('[P1] GET /api/admin/products rejects with 401 when x-admin-key is invalid', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/products`, {
      headers: { 'x-admin-key': 'invalid-key-that-is-at-least-32-chars-long-1234' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.errorCode).toBe('AUTH_INVALID_ADMIN_KEY');
  });

  // --- Supplier Source Management ---

  test('[P0] POST /api/admin/suppliers creates new supplier with valid config credentials', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/admin/suppliers`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: {
        name: 'API Automation Supplier',
        type: 'CONFIG_POOL',
        targetUrl: 'https://automation-supplier.test',
        markupPercentage: '15.00',
        markupFixedVnd: '5000.00',
        configCredentials: {
          credentialPool: ['key-1', 'key-2'],
        },
        isActive: true,
      },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.supplier).toBeDefined();
    expect(body.supplier.name).toBe('API Automation Supplier');
    expect(body.supplier.markupPercentage).toBe('15.00');
    createdSupplierId = body.supplier.id;
  });

  test('[P1] POST /api/admin/suppliers rejects invalid JSON config credentials', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/admin/suppliers`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: {
        name: 'Invalid Supplier',
        configCredentials: 'not-an-object',
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('INVALID_SUPPLIER_PAYLOAD');
  });

  // --- Product Catalog Management ---

  test('[P0] POST /api/admin/products creates product with auto-pricing calculation', async ({ request }) => {
    expect(createdSupplierId).toBeTruthy();

    const res = await request.post(`${API_URL}/api/admin/products`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      data: {
        title: 'API Auto Priced Item',
        price: '10000.00',
        category: 'Test',
        sourcingMode: 'EXTERNAL',
        supplierSourceId: createdSupplierId,
        upstreamCost: '100000.00',
        autoPricing: true,
        isActive: true,
      },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.product).toBeDefined();
    expect(body.product.title).toBe('API Auto Priced Item');
    // cost=100000 * 1.15 + 5000 = 120000.00
    expect(body.product.price).toBe('120000.00');
    createdProductId = body.product.id;
  });

  test('[P1] DELETE /api/admin/suppliers rejects deactivation when active product is linked', async ({ request }) => {
    expect(createdSupplierId).toBeTruthy();

    const res = await request.delete(`${API_URL}/api/admin/suppliers/${createdSupplierId}`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.errorCode).toBe('SUPPLIER_HAS_LINKED_PRODUCTS');
  });

  test('[P2] GET /api/admin/products supports server-side pagination and search', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/admin/products?limit=2&offset=0&search=Auto+Priced`, {
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.products.length).toBeGreaterThan(0);
    expect(body.products.length).toBeLessThanOrEqual(2);
    expect(body.products[0].title).toContain('Auto Priced');
  });

  // Cleanup
  test.afterAll(async ({ request }) => {
    if (createdProductId) {
      await request.delete(`${API_URL}/api/admin/products/${createdProductId}?hard=true`, {
        headers: { 'x-admin-key': TEST_ADMIN_KEY },
      });
    }
    if (createdSupplierId) {
      await request.delete(`${API_URL}/api/admin/suppliers/${createdSupplierId}`, {
        headers: { 'x-admin-key': TEST_ADMIN_KEY },
      });
    }
  });
});
