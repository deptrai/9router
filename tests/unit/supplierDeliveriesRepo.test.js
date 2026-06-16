// Story 2.33 — supplierDeliveriesRepo unit tests
// Verifies: insertDeliverySync, hasForwardedDeliverySync, listDeliveriesByOrder,
//           append-only (no payload column), idempotency guard.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir;
let getAdapter, insertDeliverySync, hasForwardedDeliverySync, listDeliveriesByOrder;

const TEST_ENC_KEY = "0".repeat(64);

async function loadModules() {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ insertDeliverySync, hasForwardedDeliverySync, listDeliveriesByOrder } =
    await import("@/lib/db/repos/supplierDeliveriesRepo.js"));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-supplier-deliveries-repo-"));
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

describe("insertDeliverySync", () => {
  it("inserts a delivery audit row inside a transaction", async () => {
    const adapter = await getAdapter();
    let row;
    adapter.transaction(() => {
      row = insertDeliverySync(adapter, {
        supplierOrderId: "so-001",
        orderId: "ord-001",
        deliveryType: "text",
        status: "forwarded",
      });
    });
    expect(row.id).toBeTruthy();
    expect(row.supplierOrderId).toBe("so-001");
    expect(row.orderId).toBe("ord-001");
    expect(row.deliveryType).toBe("text");
    expect(row.status).toBe("forwarded");
    expect(row.note).toBeNull();
    expect(row.createdAt).toBeTruthy();
  });

  it("stores note when provided", async () => {
    const adapter = await getAdapter();
    let row;
    adapter.transaction(() => {
      row = insertDeliverySync(adapter, {
        supplierOrderId: "so-002",
        orderId: "ord-002",
        deliveryType: "file",
        status: "unsupported",
        note: "type=file payload=missing",
      });
    });
    expect(row.note).toBe("type=file payload=missing");
  });

  it("does NOT have a payload column", async () => {
    const adapter = await getAdapter();
    const cols = adapter.all("PRAGMA table_info(supplierDeliveries)").map(c => c.name);
    expect(cols).not.toContain("payload");
    expect(cols).toContain("status");
    expect(cols).toContain("deliveryType");
    expect(cols).toContain("note");
  });

  it("appends multiple rows for the same orderId", async () => {
    const adapter = await getAdapter();
    adapter.transaction(() => {
      insertDeliverySync(adapter, { supplierOrderId: "so-003", orderId: "ord-003", deliveryType: "text", status: "forward_failed" });
      insertDeliverySync(adapter, { supplierOrderId: "so-003", orderId: "ord-003", deliveryType: "text", status: "forwarded" });
    });
    const rows = await listDeliveriesByOrder("ord-003");
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("forward_failed");
    expect(rows[1].status).toBe("forwarded");
  });
});

describe("hasForwardedDeliverySync", () => {
  it("returns false when no rows exist", async () => {
    const adapter = await getAdapter();
    adapter.transaction(() => {
      expect(hasForwardedDeliverySync(adapter, "so-none")).toBe(false);
    });
  });

  it("returns false when only unsupported row exists", async () => {
    const adapter = await getAdapter();
    adapter.transaction(() => {
      insertDeliverySync(adapter, { supplierOrderId: "so-004", orderId: "ord-004", status: "unsupported" });
      expect(hasForwardedDeliverySync(adapter, "so-004")).toBe(false);
    });
  });

  it("returns true when forwarded row exists", async () => {
    const adapter = await getAdapter();
    adapter.transaction(() => {
      insertDeliverySync(adapter, { supplierOrderId: "so-005", orderId: "ord-005", deliveryType: "credential", status: "forwarded" });
      expect(hasForwardedDeliverySync(adapter, "so-005")).toBe(true);
    });
  });

  it("returns false for a different supplierOrderId", async () => {
    const adapter = await getAdapter();
    adapter.transaction(() => {
      insertDeliverySync(adapter, { supplierOrderId: "so-006", orderId: "ord-006", status: "forwarded" });
      expect(hasForwardedDeliverySync(adapter, "so-other")).toBe(false);
    });
  });
});

describe("listDeliveriesByOrder", () => {
  it("returns empty array when no deliveries exist", async () => {
    const rows = await listDeliveriesByOrder("ord-empty");
    expect(rows).toEqual([]);
  });

  it("returns only rows for the requested orderId in createdAt ASC order", async () => {
    const adapter = await getAdapter();
    adapter.transaction(() => {
      insertDeliverySync(adapter, { supplierOrderId: "so-A", orderId: "ord-A", status: "unsupported", now: "2026-01-01T00:00:00.000Z" });
      insertDeliverySync(adapter, { supplierOrderId: "so-B", orderId: "ord-B", status: "forwarded", now: "2026-01-02T00:00:00.000Z" });
      insertDeliverySync(adapter, { supplierOrderId: "so-A2", orderId: "ord-A", status: "forwarded", now: "2026-01-03T00:00:00.000Z" });
    });
    const rows = await listDeliveriesByOrder("ord-A");
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("unsupported");
    expect(rows[1].status).toBe("forwarded");

    const rowsB = await listDeliveriesByOrder("ord-B");
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].status).toBe("forwarded");
  });
});
