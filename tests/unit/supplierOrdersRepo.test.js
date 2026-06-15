// Story 2.32 — supplierOrdersRepo unit tests
// Verifies: insert/get/update/list, idempotency recheck, findPaidExternalOrdersMissingSupplierOrder.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir;
let getAdapter, createProduct, createUser, addCredits, storeCheckout,
  insertSupplierOrderSync, getSupplierOrderByOrderIdSync, getSupplierOrderByOrderId,
  updateSupplierOrderStatus, listSupplierOrders, findPaidExternalOrdersMissingSupplierOrder,
  createSupplierSource;

const TEST_ENC_KEY = "0".repeat(64);
const EXTERNAL_SOURCE = "external_telegram_store";

async function loadModules() {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ createProduct } = await import("@/lib/db/repos/productsRepo.js"));
  ({ createUser, addCredits } = await import("@/lib/db/repos/usersRepo.js"));
  ({ storeCheckout } = await import("@/lib/store/storeCheckout.js"));
  ({ insertSupplierOrderSync, getSupplierOrderByOrderIdSync, getSupplierOrderByOrderId,
    updateSupplierOrderStatus, listSupplierOrders, findPaidExternalOrdersMissingSupplierOrder
  } = await import("@/lib/db/repos/supplierOrdersRepo.js"));
  ({ createSupplierSource } = await import("@/lib/db/repos/supplierSourcesRepo.js"));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-supplier-orders-repo-"));
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

async function seedSource() {
  return createSupplierSource({
    name: "Test Supplier",
    adapterType: "supplier_api",
    syncMode: "polling",
    auth: { apiUrl: "https://test.supplier/api", apiKey: "key123" },
  });
}

async function seedExternalProduct(sourceId, overrides = {}) {
  const adapter = await getAdapter();
  const product = await createProduct({
    kind: "service",
    name: "External Widget",
    priceCredits: overrides.priceCredits ?? 200,
    deliveryMode: "admin_fulfill",
    stock: null,
  });
  const now = new Date().toISOString();
  adapter.run(
    `UPDATE products SET source=?, supplierSourceId=?, supplierProductId=?,
     supplierPrice=?, retailPrice=?, expectedMargin=?, isPublished=?, updatedAt=?
     WHERE id=?`,
    [
      overrides.source ?? EXTERNAL_SOURCE,
      overrides.supplierSourceId ?? sourceId,
      overrides.supplierProductId ?? "ext-prod-1",
      overrides.supplierPrice ?? 150,
      overrides.retailPrice ?? 200,
      overrides.expectedMargin ?? 50,
      overrides.isPublished ?? 1,
      now,
      product.id,
    ]
  );
  return adapter.get(`SELECT * FROM products WHERE id=?`, [product.id]);
}

async function seedUser(credits = 1000) {
  const u = await createUser("buyer@test.dev", "pass", "Buyer");
  if (credits > 0) await addCredits(u.id, credits, null, { type: "admin_topup", idempotencyKey: `seed:${u.id}` });
  return u.id;
}

describe("insertSupplierOrderSync + getSupplierOrderByOrderIdSync", () => {
  it("inserts a supplierOrders row inside a transaction and retrieves it sync", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();

    let inserted;
    adapter.transaction(() => {
      inserted = insertSupplierOrderSync(adapter, {
        orderId: "order-001",
        supplierSourceId: source.id,
        supplierProductId: "ext-prod-1",
        paymentMode: "proxy_checkout",
        supplierPrice: 150,
        retailPrice: 200,
        expectedMargin: 50,
      });
    });

    expect(inserted.orderId).toBe("order-001");
    expect(inserted.supplierSourceId).toBe(source.id);
    expect(inserted.paymentMode).toBe("proxy_checkout");
    expect(inserted.supplierPrice).toBe(150);
    expect(inserted.retailPrice).toBe(200);
    expect(inserted.expectedMargin).toBe(50);
    expect(inserted.supplierOrderId).toBeNull();
    expect(inserted.qrPayload).toBeNull();

    // Sync recheck
    const found = getSupplierOrderByOrderIdSync(adapter, "order-001");
    expect(found).not.toBeNull();
    expect(found.id).toBe(inserted.id);
  });

  it("idempotency recheck: second insert returns existing row", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();

    adapter.transaction(() => {
      insertSupplierOrderSync(adapter, {
        orderId: "order-idempotent",
        supplierSourceId: source.id,
        paymentMode: "proxy_checkout",
      });
    });

    // Simulate retry: recheck prevents duplicate insert
    let secondResult;
    adapter.transaction(() => {
      const existing = getSupplierOrderByOrderIdSync(adapter, "order-idempotent");
      if (existing) {
        secondResult = existing;
        return;
      }
      secondResult = insertSupplierOrderSync(adapter, {
        orderId: "order-idempotent",
        supplierSourceId: source.id,
        paymentMode: "proxy_checkout",
      });
    });

    // Only one row exists
    const rows = adapter.all(`SELECT * FROM supplierOrders WHERE orderId = ?`, ["order-idempotent"]);
    expect(rows).toHaveLength(1);
    expect(secondResult.orderId).toBe("order-idempotent");
  });
});

describe("getSupplierOrderByOrderId (async)", () => {
  it("returns null for unknown orderId", async () => {
    const result = await getSupplierOrderByOrderId("nonexistent-order");
    expect(result).toBeNull();
  });

  it("returns mapped row for known orderId", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();

    adapter.transaction(() => {
      insertSupplierOrderSync(adapter, {
        orderId: "async-order-1",
        supplierSourceId: source.id,
        paymentMode: "proxy_checkout",
        supplierPrice: 100,
        retailPrice: 130,
        expectedMargin: 30,
      });
    });

    const result = await getSupplierOrderByOrderId("async-order-1");
    expect(result).not.toBeNull();
    expect(result.retailPrice).toBe(130);
  });
});

describe("updateSupplierOrderStatus", () => {
  it("updates supplier-side fields without touching other columns", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();

    let inserted;
    adapter.transaction(() => {
      inserted = insertSupplierOrderSync(adapter, {
        orderId: "order-update-1",
        supplierSourceId: source.id,
        paymentMode: "proxy_checkout",
        supplierPrice: 100,
        retailPrice: 130,
        expectedMargin: 30,
      });
    });

    const updated = await updateSupplierOrderStatus(inserted.id, {
      supplierOrderId: "sup-ord-999",
      supplierStatus: "pending",
    });

    expect(updated.supplierOrderId).toBe("sup-ord-999");
    expect(updated.supplierStatus).toBe("pending");
    expect(updated.retailPrice).toBe(130); // unchanged
    expect(updated.paymentMode).toBe("proxy_checkout"); // unchanged
  });
});

describe("listSupplierOrders", () => {
  it("returns all rows when no filter", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();

    adapter.transaction(() => {
      insertSupplierOrderSync(adapter, { orderId: "o1", supplierSourceId: source.id, paymentMode: "proxy_checkout" });
      insertSupplierOrderSync(adapter, { orderId: "o2", supplierSourceId: source.id, paymentMode: "proxy_checkout" });
    });

    const list = await listSupplierOrders();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by supplierSourceId", async () => {
    const adapter = await getAdapter();
    const source1 = await seedSource();
    const source2 = await createSupplierSource({
      name: "Other Supplier", adapterType: "supplier_api", syncMode: "polling",
      auth: { apiUrl: "https://other/api", apiKey: "k2" },
    });

    adapter.transaction(() => {
      insertSupplierOrderSync(adapter, { orderId: "o-s1", supplierSourceId: source1.id, paymentMode: "proxy_checkout" });
      insertSupplierOrderSync(adapter, { orderId: "o-s2", supplierSourceId: source2.id, paymentMode: "proxy_checkout" });
    });

    const list = await listSupplierOrders({ supplierSourceId: source1.id });
    expect(list.every((r) => r.supplierSourceId === source1.id)).toBe(true);
    expect(list.some((r) => r.orderId === "o-s1")).toBe(true);
    expect(list.some((r) => r.orderId === "o-s2")).toBe(false);
  });
});

describe("findPaidExternalOrdersMissingSupplierOrder", () => {
  it("returns external paid orders without supplierOrders row", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id);
    const userId = await seedUser(1000);

    // Create paid order via storeCheckout (credit path — product is admin_fulfill)
    const { order } = await storeCheckout(userId, product.id, { idempotencyKey: "orphan-test-1" });
    expect(order.status).toBe("paid");

    // No supplierOrders row inserted → should appear as orphan
    const orphans = await findPaidExternalOrdersMissingSupplierOrder();
    expect(orphans.some((o) => o.id === order.id)).toBe(true);
  });

  it("does NOT return order that has a supplierOrders row", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const product = await seedExternalProduct(source.id);
    const userId = await seedUser(1000);

    const { order } = await storeCheckout(userId, product.id, { idempotencyKey: "orphan-test-2" });

    // Insert supplierOrders row — should no longer appear as orphan
    adapter.transaction(() => {
      insertSupplierOrderSync(adapter, {
        orderId: order.id,
        supplierSourceId: source.id,
        paymentMode: "proxy_checkout",
      });
    });

    const orphans = await findPaidExternalOrdersMissingSupplierOrder();
    expect(orphans.some((o) => o.id === order.id)).toBe(false);
  });

  it("does NOT return local product orders", async () => {
    const userId = await seedUser(1000);
    const localProduct = await createProduct({
      kind: "service", name: "Local Svc", priceCredits: 50,
      deliveryMode: "admin_fulfill", stock: null,
    });

    const { order } = await storeCheckout(userId, localProduct.id, { idempotencyKey: "local-order-1" });

    const orphans = await findPaidExternalOrdersMissingSupplierOrder();
    expect(orphans.some((o) => o.id === order.id)).toBe(false);
  });
});
