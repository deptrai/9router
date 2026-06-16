// Story 2.33 — supplierOrdersRepo extended tests (coverage gaps)
// Covers: getSupplierOrderBySupplierOrderId direct lookup
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_ENC_KEY = "0".repeat(64);

let tmpDir;
let getAdapter, createSupplierSource,
  insertSupplierOrderSync, updateSupplierOrderStatus,
  getSupplierOrderBySupplierOrderId;

async function loadModules() {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ createSupplierSource } = await import("@/lib/db/repos/supplierSourcesRepo.js"));
  ({ insertSupplierOrderSync, updateSupplierOrderStatus, getSupplierOrderBySupplierOrderId } =
    await import("@/lib/db/repos/supplierOrdersRepo.js"));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-supplier-orders-repo-ext-"));
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
    syncMode: "webhook",
    auth: { apiUrl: "https://test.supplier/api", apiKey: "key", webhookSecret: "s3cret" },
  });
}

// ── P2: getSupplierOrderBySupplierOrderId ─────────────────────────────────────

describe("getSupplierOrderBySupplierOrderId", () => {
  it("returns null when no row has the given supplierOrderId", async () => {
    const result = await getSupplierOrderBySupplierOrderId("nonexistent-sup-id");
    expect(result).toBeNull();
  });

  it("returns the row after supplierOrderId is set via updateSupplierOrderStatus", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();

    let row;
    adapter.transaction(() => {
      row = insertSupplierOrderSync(adapter, {
        orderId: "order-sup-lookup-01",
        supplierSourceId: source.id,
        supplierProductId: "ext-prod-1",
        paymentMode: "proxy_checkout",
      });
    });

    // supplierOrderId is null at insert time
    expect(row.supplierOrderId).toBeNull();

    await updateSupplierOrderStatus(row.id, { supplierOrderId: "sup-ext-123" });

    const found = await getSupplierOrderBySupplierOrderId("sup-ext-123");
    expect(found).not.toBeNull();
    expect(found.id).toBe(row.id);
    expect(found.orderId).toBe("order-sup-lookup-01");
    expect(found.supplierSourceId).toBe(source.id);
    expect(found.supplierOrderId).toBe("sup-ext-123");
    expect(found.paymentMode).toBe("proxy_checkout");
  });

  it("returns null for a different supplierOrderId on the same row", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();

    let row;
    adapter.transaction(() => {
      row = insertSupplierOrderSync(adapter, {
        orderId: "order-sup-lookup-02",
        supplierSourceId: source.id,
        supplierProductId: "ext-prod-1",
        paymentMode: "proxy_checkout",
      });
    });

    await updateSupplierOrderStatus(row.id, { supplierOrderId: "sup-ext-456" });

    const notFound = await getSupplierOrderBySupplierOrderId("sup-ext-789");
    expect(notFound).toBeNull();
  });

  it("returns the correct row when multiple supplierOrders exist", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();

    let row1, row2;
    adapter.transaction(() => {
      row1 = insertSupplierOrderSync(adapter, {
        orderId: "order-multi-01",
        supplierSourceId: source.id,
        supplierProductId: "ext-prod-1",
        paymentMode: "proxy_checkout",
      });
    });
    adapter.transaction(() => {
      row2 = insertSupplierOrderSync(adapter, {
        orderId: "order-multi-02",
        supplierSourceId: source.id,
        supplierProductId: "ext-prod-2",
        paymentMode: "proxy_checkout",
      });
    });

    await updateSupplierOrderStatus(row1.id, { supplierOrderId: "sup-multi-A" });
    await updateSupplierOrderStatus(row2.id, { supplierOrderId: "sup-multi-B" });

    const foundA = await getSupplierOrderBySupplierOrderId("sup-multi-A");
    const foundB = await getSupplierOrderBySupplierOrderId("sup-multi-B");

    expect(foundA.id).toBe(row1.id);
    expect(foundA.orderId).toBe("order-multi-01");

    expect(foundB.id).toBe(row2.id);
    expect(foundB.orderId).toBe("order-multi-02");
  });
});
