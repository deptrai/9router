// Story 2.32 — externalCheckout unit tests
// Covers: proxy_checkout happy path, margin guard, disabled, vendor_mode_unsupported,
//         AC3 wholesale-QR guard, AC5 idempotency, orphan recovery, AC6 regression.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_ENC_KEY = "0".repeat(64);
const EXTERNAL_SOURCE = "external_telegram_store";

let tmpDir;
let getAdapter, createProduct, createUser, addCredits, getUserById,
  externalCheckout, ExternalCheckoutError, resolvePaymentMode, supportsVendorOrder,
  getSupplierOrderByOrderId, findPaidExternalOrdersMissingSupplierOrder,
  createSupplierSource, storeCheckout, CheckoutError;

async function loadModules() {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ createProduct } = await import("@/lib/db/repos/productsRepo.js"));
  ({ createUser, addCredits, getUserById } = await import("@/lib/db/repos/usersRepo.js"));
  ({ externalCheckout, ExternalCheckoutError, resolvePaymentMode, supportsVendorOrder } =
    await import("@/lib/store/externalCheckout.js"));
  ({ getSupplierOrderByOrderId, findPaidExternalOrdersMissingSupplierOrder } =
    await import("@/lib/db/repos/supplierOrdersRepo.js"));
  ({ createSupplierSource } = await import("@/lib/db/repos/supplierSourcesRepo.js"));
  ({ storeCheckout, CheckoutError } = await import("@/lib/store/storeCheckout.js"));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-ext-checkout-"));
  process.env.DATA_DIR = tmpDir;
  process.env.STORE_ENC_KEY = TEST_ENC_KEY;
  delete global._dbAdapter;
  vi.resetModules();
  await loadModules();
  await getAdapter();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.STORE_ENC_KEY;
});

async function seedSource(overrides = {}) {
  return createSupplierSource({
    name: "Test Supplier",
    adapterType: "supplier_api",
    syncMode: "polling",
    auth: { apiUrl: "https://test.supplier/api", apiKey: "k" },
    ...overrides,
  });
}

async function seedExternalProduct(sourceId, overrides = {}) {
  const adapter = await getAdapter();
  const product = await createProduct({
    kind: "service",
    name: overrides.name ?? "External Widget",
    priceCredits: overrides.priceCredits ?? 200,
    deliveryMode: "admin_fulfill",
    stock: null,
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
  });
  const now = new Date().toISOString();
  adapter.run(
    `UPDATE products SET source=?, supplierSourceId=?, supplierProductId=?,
     supplierPrice=?, retailPrice=?, expectedMargin=?, isPublished=?,
     paymentModeOverride=?, updatedAt=?
     WHERE id=?`,
    [
      overrides.source ?? EXTERNAL_SOURCE,
      overrides.supplierSourceId ?? sourceId,
      overrides.supplierProductId ?? "ext-prod-1",
      overrides.supplierPrice ?? 150,
      overrides.retailPrice ?? 200,
      overrides.expectedMargin ?? 50,
      overrides.isPublished !== undefined ? (overrides.isPublished ? 1 : 0) : 1,
      overrides.paymentModeOverride ?? null,
      now,
      product.id,
    ]
  );
  // Sync priceCredits to retailPrice unless overridden differently
  if (overrides.priceCredits === undefined) {
    adapter.run(`UPDATE products SET priceCredits=? WHERE id=?`, [
      overrides.retailPrice ?? 200,
      product.id,
    ]);
  }
  return adapter.get(`SELECT * FROM products WHERE id=?`, [product.id]);
}

async function seedUser(credits = 1000) {
  const u = await createUser("buyer@test.dev", "pass", "Buyer");
  if (credits > 0) {
    await addCredits(u.id, credits, null, { type: "admin_topup", idempotencyKey: `seed:${u.id}` });
  }
  return u;
}

// ─── proxy_checkout happy path ────────────────────────────────────────────────

describe("proxy_checkout — happy path", () => {
  it("creates internal order (paid) + supplierOrders row with correct snapshot", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id);
    const user = await seedUser(1000);

    const result = await externalCheckout(user.id, product.id, { idempotencyKey: "ext-buy-1" });

    expect(result.alreadyProcessed).toBe(false);
    expect(result.paymentMode).toBe("proxy_checkout");
    expect(result.order.status).toBe("paid"); // admin_fulfill stays paid
    expect(result.order.totalCredits).toBe(200); // retailPrice
    expect(result.items).toHaveLength(1);

    // supplierOrders row created
    expect(result.supplierOrder).not.toBeNull();
    expect(result.supplierOrder.orderId).toBe(result.order.id);
    expect(result.supplierOrder.supplierSourceId).toBe(source.id);
    expect(result.supplierOrder.supplierProductId).toBe("ext-prod-1");
    expect(result.supplierOrder.paymentMode).toBe("proxy_checkout");
    expect(result.supplierOrder.supplierPrice).toBe(150);
    expect(result.supplierOrder.retailPrice).toBe(200);
    expect(result.supplierOrder.expectedMargin).toBe(50);
    expect(result.supplierOrder.supplierOrderId).toBeNull(); // not placed upstream yet
    expect(result.supplierOrder.qrPayload).toBeNull();

    // User was charged retailPrice
    const updated = await getUserById(user.id);
    expect(updated.creditsBalance).toBe(800); // 1000 - 200
  });

  it("supplierOrders row is accessible via getSupplierOrderByOrderId after checkout", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id);
    const user = await seedUser(500);

    const { order } = await externalCheckout(user.id, product.id, { idempotencyKey: "ext-buy-2" });
    const soRow = await getSupplierOrderByOrderId(order.id);

    expect(soRow).not.toBeNull();
    expect(soRow.orderId).toBe(order.id);
  });
});

// ─── Margin guard (AC2) ───────────────────────────────────────────────────────

describe("margin guard — AC2", () => {
  it("rejects when retailPrice is null", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id, { retailPrice: null, priceCredits: 150 });
    const user = await seedUser(1000);

    await expect(externalCheckout(user.id, product.id)).rejects.toMatchObject({
      name: "ExternalCheckoutError",
      code: "MARGIN_VIOLATION",
    });

    // No order created, no credit deducted
    const u = await getUserById(user.id);
    expect(u.creditsBalance).toBe(1000);
  });

  it("rejects when retailPrice <= supplierPrice (zero margin)", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id, {
      supplierPrice: 200,
      retailPrice: 200,
      priceCredits: 200,
      expectedMargin: 0,
    });
    const user = await seedUser(1000);

    await expect(externalCheckout(user.id, product.id)).rejects.toMatchObject({
      code: "MARGIN_VIOLATION",
    });
  });

  it("rejects when retailPrice < supplierPrice (negative margin)", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id, {
      supplierPrice: 250,
      retailPrice: 200,
      priceCredits: 200,
      expectedMargin: -50,
    });
    const user = await seedUser(1000);

    await expect(externalCheckout(user.id, product.id)).rejects.toMatchObject({
      code: "MARGIN_VIOLATION",
    });
  });

  it("rejects when priceCredits diverges from retailPrice (stale sync before markup)", async () => {
    const source = await seedSource();
    // priceCredits=150 but retailPrice=200 → diverged (markup applied to retailPrice but not priceCredits)
    const product = await seedExternalProduct(source.id, {
      supplierPrice: 100,
      retailPrice: 200,
      priceCredits: 150, // diverged
      expectedMargin: 100,
    });
    const user = await seedUser(1000);

    await expect(externalCheckout(user.id, product.id)).rejects.toMatchObject({
      code: "MARGIN_VIOLATION",
    });
  });
});

// ─── PRODUCT_DISABLED (AC4) ───────────────────────────────────────────────────

describe("PRODUCT_DISABLED — AC4", () => {
  it("rejects when paymentModeOverride = disabled", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id, { paymentModeOverride: "disabled" });
    const user = await seedUser(1000);    await expect(externalCheckout(user.id, product.id)).rejects.toMatchObject({
      code: "PRODUCT_DISABLED",
    });

    const u = await getUserById(user.id);
    expect(u.creditsBalance).toBe(1000); // no charge
  });

  it("rejects when source default paymentMode = disabled and no override", async () => {
    const source = await seedSource();
    // Update source paymentMode to disabled via adapter
    const adapter = await getAdapter();
    adapter.run(`UPDATE supplierSources SET paymentMode = 'disabled' WHERE id = ?`, [source.id]);

    const product = await seedExternalProduct(source.id); // no override → inherits source
    const user = await seedUser(1000);

    await expect(externalCheckout(user.id, product.id)).rejects.toMatchObject({
      code: "PRODUCT_DISABLED",
    });
  });
});

// ─── VENDOR_MODE_UNSUPPORTED + AC3 wholesale-QR guard ────────────────────────

describe("VENDOR_MODE_UNSUPPORTED — AC3 wholesale-QR guard", () => {
  it("rejects vendor_commission when supportsVendorOrder = false", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id, { paymentModeOverride: "vendor_commission" });
    const user = await seedUser(1000);

    await expect(externalCheckout(user.id, product.id)).rejects.toMatchObject({
      code: "VENDOR_MODE_UNSUPPORTED",
    });

    const u = await getUserById(user.id);
    expect(u.creditsBalance).toBe(1000); // no charge
  });

  it("rejects separate_fee when supportsVendorOrder = false", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id, { paymentModeOverride: "separate_fee" });
    const user = await seedUser(1000);

    await expect(externalCheckout(user.id, product.id)).rejects.toMatchObject({
      code: "VENDOR_MODE_UNSUPPORTED",
    });
  });

  // AC3 guard: even if a supplier adapter somehow provides a getQR or similar method,
  // the gate checks supportsVendorOrder (requires createSupplierOrder), not getQR.
  // An adapter with getQR but no createSupplierOrder must still be rejected.
  it("AC3 guard: adapter with getQR but no createSupplierOrder is still rejected", () => {
    const adapterWithGetQR = {
      validate: () => ({ ok: true }),
      fetchCatalog: async () => ({ products: [] }),
      normalizeProduct: (r) => r,
      getQR: async () => ({ qrUrl: "https://supplier/wholesale-qr?amount=150" }), // wholesale QR
      // NO createSupplierOrder — supportsVendorOrder() must return false
    };

    // supportsVendorOrder checks for createSupplierOrder specifically
    expect(supportsVendorOrder(adapterWithGetQR)).toBe(false);

    // vendor_commission with such an adapter is unsupported → QR never forwarded
    // (The rejection happens before any adapter method is called — purely capability-gated)
  });

  it("supportsVendorOrder returns false for all current adapters (read-only)", () => {
    // All 4 current adapters: supplier_api, channel_feed, polling_feed, webhook
    // None has createSupplierOrder → all return false
    const readOnlyAdapter = {
      validate: () => ({}),
      fetchCatalog: async () => ({ products: [] }),
      normalizeProduct: (r) => r,
    };
    expect(supportsVendorOrder(readOnlyAdapter)).toBe(false);
    expect(supportsVendorOrder(null)).toBe(false);
    expect(supportsVendorOrder(undefined)).toBe(false);
  });

  it("supportsVendorOrder returns true only when createSupplierOrder is a function", () => {
    const futureAdapter = {
      validate: () => ({}),
      fetchCatalog: async () => ({ products: [] }),
      normalizeProduct: (r) => r,
      createSupplierOrder: async (order) => ({ supplierOrderId: "sup-123" }), // future capability
    };
    expect(supportsVendorOrder(futureAdapter)).toBe(true);
  });
});

// ─── NOT_EXTERNAL / NOT_PUBLISHED guards ─────────────────────────────────────

describe("product validation guards", () => {
  it("rejects local product with NOT_EXTERNAL", async () => {
    const user = await seedUser(500);
    const localProduct = await createProduct({
      kind: "service", name: "Local Svc", priceCredits: 50,
      deliveryMode: "admin_fulfill", stock: null,
      // source defaults to 'local'
    });

    await expect(externalCheckout(user.id, localProduct.id)).rejects.toMatchObject({
      code: "NOT_EXTERNAL",
    });
  });

  it("rejects unpublished external product with NOT_PUBLISHED", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id, { isPublished: 0 });
    const user = await seedUser(500);

    await expect(externalCheckout(user.id, product.id)).rejects.toMatchObject({
      code: "NOT_PUBLISHED",
    });
  });

  it("rejects inactive external product with NOT_PUBLISHED", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id, { isActive: 0, isPublished: 0 });
    const user = await seedUser(500);

    await expect(externalCheckout(user.id, product.id)).rejects.toMatchObject({
      code: "NOT_PUBLISHED",
    });
  });

  it("rejects missing supplierSource with SUPPLIER_NOT_FOUND", async () => {
    const user = await seedUser(500);
    const adapter = await getAdapter();
    // Use raw SQL to correctly set source=EXTERNAL_SOURCE
    const prodId = crypto.randomUUID();
    const now = new Date().toISOString();
    adapter.run(
      `INSERT INTO products(id, kind, name, priceCredits, deliveryMode, stock, isActive,
       source, supplierSourceId, supplierProductId, supplierPrice, retailPrice, expectedMargin, isPublished, createdAt, updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [prodId, "service", "Orphan External", 200, "admin_fulfill", null, 1,
       EXTERNAL_SOURCE, "nonexistent-source-id", "ext-x", 150, 200, 50, 1, now, now]
    );

    await expect(externalCheckout(user.id, prodId)).rejects.toMatchObject({
      code: "SUPPLIER_NOT_FOUND",
    });
  });
});

// ─── Idempotency (AC5) ────────────────────────────────────────────────────────

describe("idempotency — AC5", () => {
  it("two calls with same idempotencyKey produce only 1 order + 1 supplierOrders row", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id);
    const user = await seedUser(1000);

    const key = "idem-test-1";
    const r1 = await externalCheckout(user.id, product.id, { idempotencyKey: key });
    const r2 = await externalCheckout(user.id, product.id, { idempotencyKey: key });

    expect(r1.order.id).toBe(r2.order.id);
    expect(r2.alreadyProcessed).toBe(true);

    // Only one credit deduction
    const u = await getUserById(user.id);
    expect(u.creditsBalance).toBe(800); // deducted only once

    // Only one supplierOrders row
    const adapter = await getAdapter();
    const soRows = adapter.all(
      `SELECT * FROM supplierOrders WHERE orderId = ?`,
      [r1.order.id]
    );
    expect(soRows).toHaveLength(1);
  });

  it("retry with same key recovers orphan supplierOrders row", async () => {
    // Simulate: first call storeCheckout committed but supplierOrders insert failed (orphan).
    // Retry with same key must recover the supplierOrders row idempotently.
    const source = await seedSource();
    const product = await seedExternalProduct(source.id);
    const user = await seedUser(1000);
    const adapter = await getAdapter();

    // First call succeeds normally
    const r1 = await externalCheckout(user.id, product.id, { idempotencyKey: "orphan-retry-1" });
    expect(r1.supplierOrder).not.toBeNull();

    // Simulate orphan: delete the supplierOrders row (as if the insert had failed)
    adapter.run(`DELETE FROM supplierOrders WHERE orderId = ?`, [r1.order.id]);
    const orphans = await findPaidExternalOrdersMissingSupplierOrder();
    expect(orphans.some((o) => o.id === r1.order.id)).toBe(true);

    // Retry with same key → storeCheckout returns alreadyProcessed=true, but externalCheckout
    // must still insert the missing supplierOrders row (orphan recovery)
    const r2 = await externalCheckout(user.id, product.id, { idempotencyKey: "orphan-retry-1" });
    expect(r2.alreadyProcessed).toBe(true);
    expect(r2.order.id).toBe(r1.order.id);
    expect(r2.supplierOrder).not.toBeNull(); // row recovered

    // No longer an orphan
    const orphansAfter = await findPaidExternalOrdersMissingSupplierOrder();
    expect(orphansAfter.some((o) => o.id === r1.order.id)).toBe(false);

    // Still only one credit deduction
    const u = await getUserById(user.id);
    expect(u.creditsBalance).toBe(800);
  });
});

// ─── resolvePaymentMode helper ────────────────────────────────────────────────

describe("resolvePaymentMode", () => {
  it("uses product override when set", () => {
    const product = { paymentModeOverride: "disabled", source: EXTERNAL_SOURCE };
    const source = { paymentMode: "proxy_checkout" };
    expect(resolvePaymentMode(product, source)).toBe("disabled");
  });

  it("falls back to source.paymentMode when override is null", () => {
    const product = { paymentModeOverride: null };
    const source = { paymentMode: "vendor_commission" };
    expect(resolvePaymentMode(product, source)).toBe("vendor_commission");
  });

  it("falls back to proxy_checkout when both are null/undefined", () => {
    const product = { paymentModeOverride: null };
    const source = { paymentMode: null };
    expect(resolvePaymentMode(product, source)).toBe("proxy_checkout");
  });

  it("falls back to proxy_checkout for unknown mode value", () => {
    const product = { paymentModeOverride: "bogus_mode" };
    const source = { paymentMode: "proxy_checkout" };
    expect(resolvePaymentMode(product, source)).toBe("proxy_checkout");
  });
});

// ─── AC6 regression: local product checkout unchanged ────────────────────────

describe("AC6 regression — local product storeCheckout unaffected", () => {
  it("storeCheckout still works correctly for local admin_fulfill product", async () => {
    const user = await seedUser(500);
    const localProduct = await createProduct({
      kind: "service", name: "Local Admin", priceCredits: 100,
      deliveryMode: "admin_fulfill", stock: null,
    });

    const result = await storeCheckout(user.id, localProduct.id, { idempotencyKey: "local-checkout-1" });

    expect(result.alreadyProcessed).toBe(false);
    expect(result.order.status).toBe("paid");
    expect(result.order.totalCredits).toBe(100);

    const u = await getUserById(user.id);
    expect(u.creditsBalance).toBe(400);
  });

  it("externalCheckout does NOT affect local product storeCheckout orders schema", async () => {
    const source = await seedSource();
    const extProduct = await seedExternalProduct(source.id);
    const localProduct = await createProduct({
      kind: "service", name: "Local", priceCredits: 50,
      deliveryMode: "admin_fulfill", stock: null,
    });
    const user = await seedUser(1000);

    // Do an external checkout
    await externalCheckout(user.id, extProduct.id, { idempotencyKey: "ext-ac6" });

    // Local checkout still works, order has no supplierOrders row
    const localResult = await storeCheckout(user.id, localProduct.id, { idempotencyKey: "local-ac6" });
    expect(localResult.order.status).toBe("paid");

    const adapter = await getAdapter();
    const soRows = adapter.all(
      `SELECT * FROM supplierOrders WHERE orderId = ?`,
      [localResult.order.id]
    );
    expect(soRows).toHaveLength(0); // no tracking row for local order
  });
});
