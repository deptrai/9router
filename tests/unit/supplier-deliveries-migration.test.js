// Story 2.33 — migration 013 unit tests
// Verifies: supplierDeliveries table created, correct columns (no payload), index exists, idempotent.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir;
let getAdapter;

const TEST_ENC_KEY = "0".repeat(64);

async function loadModules() {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-migration-013-"));
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

describe("migration 013 — supplierDeliveries table", () => {
  it("creates the supplierDeliveries table", async () => {
    const adapter = await getAdapter();
    const row = adapter.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='supplierDeliveries'`
    );
    expect(row?.name).toBe("supplierDeliveries");
  });

  it("has the correct columns (no payload column)", async () => {
    const adapter = await getAdapter();
    const cols = adapter.all("PRAGMA table_info(supplierDeliveries)").map(c => c.name);
    expect(cols).toContain("id");
    expect(cols).toContain("supplierOrderId");
    expect(cols).toContain("orderId");
    expect(cols).toContain("deliveryType");
    expect(cols).toContain("status");
    expect(cols).toContain("note");
    expect(cols).toContain("createdAt");
    expect(cols).not.toContain("payload");
  });

  it("creates idx_supplier_delivery_order index", async () => {
    const adapter = await getAdapter();
    const idx = adapter.get(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_supplier_delivery_order'`
    );
    expect(idx?.name).toBe("idx_supplier_delivery_order");
  });

  it("is idempotent — running migration again does not throw", async () => {
    const adapter = await getAdapter();
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const m013 = MIGRATIONS.find(m => m.version === 13);
    expect(() => m013.up(adapter.instance ?? adapter)).not.toThrow();
  });

  it("backward-compat: supplierOrders table still exists after migration 013", async () => {
    const adapter = await getAdapter();
    const row = adapter.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='supplierOrders'`
    );
    expect(row?.name).toBe("supplierOrders");
  });
});
