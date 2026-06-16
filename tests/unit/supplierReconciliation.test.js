// Story 2.34 (T7/AC4-AC6) — supplierReconciliation sweep tests.
// Covers: orphan detection, negative-margin flag, stale-order flag, idempotency, fail-soft,
//         and full reconcileSupplierOrders() aggregate counts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";

const EXTERNAL_SOURCE = "external_telegram_store";

let tmpDir;
let getAdapter, createUser,
  reconcileSupplierOrders, detectOrphanOrders, detectNegativeMargins, detectStaleOrders,
  STALE_THRESHOLD_MS, RECONCILE_FLAGS;

async function loadModules() {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ createUser } = await import("@/lib/db/repos/usersRepo.js"));
  ({
    reconcileSupplierOrders, detectOrphanOrders, detectNegativeMargins, detectStaleOrders,
    STALE_THRESHOLD_MS, RECONCILE_FLAGS,
  } = await import("@/lib/store/supplierReconciliation.js"));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-reconcile-"));
  process.env.DATA_DIR = tmpDir;
  process.env.STORE_ENC_KEY = "0".repeat(64);
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

// ── Direct seed helpers (bypass checkout — we drive the DB into each exception shape) ──

async function seedUser() {
  return createUser(`buyer-${uuidv4().slice(0, 8)}@test.dev`, "pass", "Buyer");
}

async function seedSource(status = "active") {
  const adapter = await getAdapter();
  const id = uuidv4();
  const now = new Date().toISOString();
  adapter.run(
    `INSERT INTO supplierSources(id, name, adapterType, authEnc, syncMode, syncIntervalSec, status, lastSyncedAt, lastSyncError, syncVersion, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "Src", "supplier_api", null, "polling", 3600, status, null, null, 0, 1, now, now]
  );
  return id;
}

async function seedProduct(sourceId) {
  const adapter = await getAdapter();
  const id = uuidv4();
  const now = new Date().toISOString();
  adapter.run(
    `INSERT INTO products(id, kind, name, priceCredits, deliveryMode, stock, isActive, source, supplierSourceId, supplierProductId, supplierPrice, retailPrice, expectedMargin, isPublished, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "service", "Widget", 200, "admin_fulfill", null, 1, EXTERNAL_SOURCE, sourceId, "ext-1", 150, 200, 50, 1, now, now]
  );
  return id;
}

/**
 * Seed a paid external order. opts:
 *   withSupplierOrder: insert a supplierOrders row (false → orphan)
 *   margin: expectedMargin for the supplierOrders row
 *   supplierStatus: supplierOrders.supplierStatus (null → unstarted upstream)
 *   createdAt: ISO for the order (stale tests)
 *   note: pre-existing order note (idempotency tests)
 */
async function seedPaidOrder(userId, productId, sourceId, opts = {}) {
  const adapter = await getAdapter();
  const orderId = uuidv4();
  const now = opts.createdAt || new Date().toISOString();
  const status = opts.status ?? "paid";
  adapter.run(
    `INSERT INTO orders(id, userId, status, source, totalCredits, deliveryMode, note, createdAt, updatedAt)
     VALUES(?, ?, ?, 'telegram', 200, 'admin_fulfill', ?, ?, ?)`,
    [orderId, userId, status, opts.note ?? null, now, now]
  );
  adapter.run(
    `INSERT INTO orderItems(id, orderId, productId, productName, kind, deliveryMode, unitCredits, quantity, createdAt)
     VALUES(?, ?, ?, 'Widget', 'service', 'admin_fulfill', 200, 1, ?)`,
    [uuidv4(), orderId, productId, now]
  );
  if (opts.withSupplierOrder !== false) {
    adapter.run(
      `INSERT INTO supplierOrders(id, orderId, supplierSourceId, supplierProductId, paymentMode, supplierPrice, retailPrice, expectedMargin, supplierStatus, createdAt, updatedAt)
       VALUES(?, ?, ?, 'ext-1', 'proxy_checkout', 150, 200, ?, ?, ?, ?)`,
      [uuidv4(), orderId, sourceId, opts.margin ?? 50, opts.supplierStatus ?? null, now, now]
    );
  }
  return orderId;
}

function getNote(adapter, orderId) {
  return adapter.get(`SELECT note FROM orders WHERE id=?`, [orderId])?.note ?? null;
}

// ── AC4: orphan detection ──
describe("detectOrphanOrders (AC4)", () => {
  it("flags paid external order missing supplierOrders row", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    const orderId = await seedPaidOrder(user.id, productId, sourceId, { withSupplierOrder: false });

    const n = await detectOrphanOrders(adapter);
    expect(n).toBe(1);
    expect(getNote(adapter, orderId)).toBe(RECONCILE_FLAGS.ORPHAN);
  });

  it("does NOT flag order that already has a supplierOrders row", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    const orderId = await seedPaidOrder(user.id, productId, sourceId, { withSupplierOrder: true });

    const n = await detectOrphanOrders(adapter);
    expect(n).toBe(0);
    expect(getNote(adapter, orderId)).toBeNull();
  });
});

// ── AC5: negative-margin flag ──
describe("detectNegativeMargins (AC5)", () => {
  it("flags order whose supplierOrders.expectedMargin < 0", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    const orderId = await seedPaidOrder(user.id, productId, sourceId, { margin: -20 });

    const n = await detectNegativeMargins(adapter);
    expect(n).toBe(1);
    expect(getNote(adapter, orderId)).toBe(RECONCILE_FLAGS.NEGATIVE_MARGIN);
  });

  it("does NOT flag positive-margin order", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    const orderId = await seedPaidOrder(user.id, productId, sourceId, { margin: 50 });

    const n = await detectNegativeMargins(adapter);
    expect(n).toBe(0);
    expect(getNote(adapter, orderId)).toBeNull();
  });

  // Review patch (2026-06-16): negative-margin detector must ignore resolved orders
  // (cancelled/refunded/fulfilled) so the hourly sweep never re-flags or clobbers an
  // admin's resolution note on an order that is no longer 'paid'.
  it("does NOT flag negative-margin order whose status is no longer 'paid'", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    const cancelled = await seedPaidOrder(user.id, productId, sourceId, { margin: -20, status: "cancelled" });
    const refunded = await seedPaidOrder(user.id, productId, sourceId, { margin: -20, status: "refunded" });

    const n = await detectNegativeMargins(adapter);
    expect(n).toBe(0);
    expect(getNote(adapter, cancelled)).toBeNull();
    expect(getNote(adapter, refunded)).toBeNull();
  });
});

// ── AC6: stale-order flag ──
describe("detectStaleOrders (AC6)", () => {
  it("flags paid external order older than threshold with null supplierStatus", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    const oldISO = new Date(Date.now() - STALE_THRESHOLD_MS - 60_000).toISOString();
    const orderId = await seedPaidOrder(user.id, productId, sourceId, {
      createdAt: oldISO, supplierStatus: null,
    });

    const n = await detectStaleOrders(adapter);
    expect(n).toBe(1);
    expect(getNote(adapter, orderId)).toBe(RECONCILE_FLAGS.STALE);
  });

  it("does NOT flag recent order", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    const orderId = await seedPaidOrder(user.id, productId, sourceId, { supplierStatus: null });

    const n = await detectStaleOrders(adapter);
    expect(n).toBe(0);
    expect(getNote(adapter, orderId)).toBeNull();
  });

  it("does NOT flag stale order that already has supplierStatus set", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    const oldISO = new Date(Date.now() - STALE_THRESHOLD_MS - 60_000).toISOString();
    const orderId = await seedPaidOrder(user.id, productId, sourceId, {
      createdAt: oldISO, supplierStatus: "paid",
    });

    const n = await detectStaleOrders(adapter);
    expect(n).toBe(0);
    expect(getNote(adapter, orderId)).toBeNull();
  });

  it("respects injectable now clock", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    // Order created "now"; with a future clock it becomes stale.
    const orderId = await seedPaidOrder(user.id, productId, sourceId, { supplierStatus: null });
    const future = Date.now() + STALE_THRESHOLD_MS + 60_000;

    expect(await detectStaleOrders(adapter, { now: future })).toBe(1);
    expect(getNote(adapter, orderId)).toBe(RECONCILE_FLAGS.STALE);
  });
});

// ── Idempotency ──
describe("idempotency — no re-flag", () => {
  it("orphan re-run does not append/duplicate flag", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    const orderId = await seedPaidOrder(user.id, productId, sourceId, { withSupplierOrder: false });

    expect(await detectOrphanOrders(adapter)).toBe(1);
    expect(await detectOrphanOrders(adapter)).toBe(0); // already flagged
    expect(getNote(adapter, orderId)).toBe(RECONCILE_FLAGS.ORPHAN);
  });

  it("negative-margin skips order already carrying any NEEDS_ flag", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    const orderId = await seedPaidOrder(user.id, productId, sourceId, {
      margin: -20, note: RECONCILE_FLAGS.ORPHAN,
    });

    expect(await detectNegativeMargins(adapter)).toBe(0);
    expect(getNote(adapter, orderId)).toBe(RECONCILE_FLAGS.ORPHAN); // unchanged
  });
});

// ── reconcileSupplierOrders aggregate (QĐ1) ──
describe("reconcileSupplierOrders (aggregate)", () => {
  it("returns counts across all three detectors", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);

    await seedPaidOrder(user.id, productId, sourceId, { withSupplierOrder: false }); // orphan
    await seedPaidOrder(user.id, productId, sourceId, { margin: -10 });              // negative
    const oldISO = new Date(Date.now() - STALE_THRESHOLD_MS - 60_000).toISOString();
    await seedPaidOrder(user.id, productId, sourceId, { createdAt: oldISO, supplierStatus: null }); // stale

    const result = await reconcileSupplierOrders();
    expect(result.orphans).toBe(1);
    expect(result.negativeMargins).toBe(1);
    expect(result.staleOrders).toBe(1);
  });

  it("is fail-soft: a detector throwing does not abort the others (guarded counts)", async () => {
    const adapter = await getAdapter();
    const user = await seedUser();
    const sourceId = await seedSource();
    const productId = await seedProduct(sourceId);
    await seedPaidOrder(user.id, productId, sourceId, { withSupplierOrder: false }); // orphan
    await seedPaidOrder(user.id, productId, sourceId, { margin: -10 });              // negative

    // Make ONLY the stale detector throw by stubbing adapter.all for its specific query.
    // The reconcile guard must still return orphan + negative counts (other detectors run).
    const realAll = adapter.all.bind(adapter);
    const spy = vi.spyOn(adapter, "all").mockImplementation((sql, params) => {
      if (typeof sql === "string" && sql.includes("so.supplierStatus IS NULL")) {
        throw new Error("injected stale-detector failure");
      }
      return realAll(sql, params);
    });

    const result = await reconcileSupplierOrders();
    spy.mockRestore();

    expect(result.orphans).toBe(1);
    expect(result.negativeMargins).toBe(1);
    expect(result.staleOrders).toBe(0); // threw internally, guarded → 0
  });
});
