// Story 2.32 — migration 012: supplierOrders table + paymentMode columns
// Verifies: table creation, ALTER columns, backward-compat for local products.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-migration-012-"));
  process.env.DATA_DIR = tmpDir;
  process.env.STORE_ENC_KEY = "0".repeat(64);
  delete global._dbAdapter;
  vi.resetModules?.();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  rmSync(tmpDir, { recursive: true, force: true });
});

import { vi } from "vitest";

describe("migration 012 — supplierOrders + paymentMode columns", () => {
  it("creates supplierOrders table with correct columns", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();

    const cols = adapter.all(`PRAGMA table_info(supplierOrders)`).map((r) => r.name);
    expect(cols).toContain("id");
    expect(cols).toContain("orderId");
    expect(cols).toContain("supplierSourceId");
    expect(cols).toContain("supplierProductId");
    expect(cols).toContain("paymentMode");
    expect(cols).toContain("supplierOrderId");
    expect(cols).toContain("supplierInvoiceId");
    expect(cols).toContain("qrPayload");
    expect(cols).toContain("supplierPrice");
    expect(cols).toContain("retailPrice");
    expect(cols).toContain("expectedMargin");
    expect(cols).toContain("supplierStatus");
    expect(cols).toContain("createdAt");
    expect(cols).toContain("updatedAt");
  });

  it("creates indexes on supplierOrders", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();

    const indexes = adapter
      .all(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='supplierOrders'`)
      .map((r) => r.name);
    expect(indexes).toContain("idx_supplier_order_order");
    expect(indexes).toContain("idx_supplier_order_source");
  });

  it("adds paymentMode column to supplierSources with default 'proxy_checkout'", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();

    const cols = adapter.all(`PRAGMA table_info(supplierSources)`).map((r) => r.name);
    expect(cols).toContain("paymentMode");

    // Verify default value definition
    const colDef = adapter
      .all(`PRAGMA table_info(supplierSources)`)
      .find((r) => r.name === "paymentMode");
    expect(colDef.dflt_value).toBe("'proxy_checkout'");
  });

  it("adds paymentModeOverride column to products (nullable)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();

    const cols = adapter.all(`PRAGMA table_info(products)`).map((r) => r.name);
    expect(cols).toContain("paymentModeOverride");

    // Null by default — backward compat for local products
    const colDef = adapter
      .all(`PRAGMA table_info(products)`)
      .find((r) => r.name === "paymentModeOverride");
    expect(colDef.notnull).toBe(0); // nullable
    expect(colDef.dflt_value).toBeNull();
  });

  it("local product paymentModeOverride stays null after migration", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createProduct } = await import("@/lib/db/repos/productsRepo.js");
    const adapter = await getAdapter();

    const product = await createProduct({
      kind: "service",
      name: "Local Service",
      priceCredits: 100,
      deliveryMode: "instant",
    });

    const row = adapter.get(`SELECT paymentModeOverride FROM products WHERE id = ?`, [product.id]);
    expect(row.paymentModeOverride).toBeNull();
  });

  it("migration is idempotent (running twice does not error)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();

    // Import and run migration 012 directly a second time
    const { default: m012 } = await import("@/lib/db/migrations/012-supplier-orders.js");
    expect(() => m012.up(adapter)).not.toThrow();
  });
});
