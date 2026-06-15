/**
 * Story 2.31 — migration 011 backfill + AC2 e2e + AC5 regression (T1/T6/T7).
 * - Migration 011 backfills supplierPrice = priceCredits for legacy external products.
 * - AC2 e2e: publishProduct → listActiveProducts returns the product with retailPrice as
 *   display price AND priceCredits === retailPrice (checkout↔display invariant).
 * - AC5 regression: local products unaffected by markup columns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";

let tmpDir;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-markup-migration-"));
  process.env.DATA_DIR = tmpDir;
  process.env.STORE_ENC_KEY = "0".repeat(64);
  delete global._dbAdapter;
  vi.resetModules();
  const { getAdapter } = await import("@/lib/db/driver.js");
  await getAdapter();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Migration 011 backfill ───────────────────────────────────────────────────
describe("migration 011 — backfill supplierPrice (T1)", () => {
  it("backfills supplierPrice = priceCredits for external products with NULL supplierPrice", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const now = new Date().toISOString();

    // Simulate a legacy external product synced pre-2.31: supplierPrice=NULL,
    // raw supplier price held only in priceCredits.
    const extId = uuidv4();
    db.run(
      `INSERT INTO products(id, kind, name, priceCredits, deliveryMode, isActive, isPublished,
         source, supplierSourceId, supplierProductId, supplierPrice, createdAt, updatedAt)
       VALUES(?, 'service', 'Legacy Ext', 70, 'admin_fulfill', 0, 0,
         'external_telegram_store', 'sup-1', 'sp-1', NULL, ?, ?)`,
      [extId, now, now]
    );
    // A local product must NOT be touched by the backfill.
    const localId = uuidv4();
    db.run(
      `INSERT INTO products(id, kind, name, priceCredits, deliveryMode, isActive, source, supplierPrice, createdAt, updatedAt)
       VALUES(?, 'service', 'Local', 42, 'instant', 1, 'local', NULL, ?, ?)`,
      [localId, now, now]
    );

    // Re-run the migration up() (idempotent — columns already exist, only backfill runs).
    const m011 = (await import("@/lib/db/migrations/011-markup-rules.js")).default;
    m011.up(db);

    const ext = db.get(`SELECT * FROM products WHERE id = ?`, [extId]);
    expect(ext.supplierPrice).toBe(70); // backfilled from priceCredits

    const local = db.get(`SELECT * FROM products WHERE id = ?`, [localId]);
    expect(local.supplierPrice).toBeNull(); // local untouched
  });
});

// ─── AC2 e2e: publish → catalog ───────────────────────────────────────────────
describe("AC2 e2e — publish → listActiveProducts (T7)", () => {
  it("published product appears with retailPrice as display + priceCredits === retailPrice", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const now = new Date().toISOString();
    const id = uuidv4();
    db.run(
      `INSERT INTO products(id, kind, name, priceCredits, deliveryMode, isActive, isPublished,
         source, supplierSourceId, supplierProductId, supplierPrice, createdAt, updatedAt)
       VALUES(?, 'service', 'Ext Sellable', 100, 'admin_fulfill', 0, 0,
         'external_telegram_store', 'sup-1', 'sp-1', 100, ?, ?)`,
      [id, now, now]
    );

    // Apply markup, then publish.
    const { createMarkupRule } = await import("@/lib/db/repos/markupRulesRepo.js");
    await createMarkupRule({ productId: id, markupPct: 30, roundingRule: "none" });
    const { applyMarkupToProduct, publishProduct } = await import("@/lib/store/markupEngine.js");
    await applyMarkupToProduct(id);
    await publishProduct(id);

    const { listActiveProducts } = await import("@/lib/db/repos/productsRepo.js");
    const active = await listActiveProducts();
    const found = active.find((p) => p.id === id);

    expect(found).toBeDefined();            // (a) product appears in catalog
    expect(found.retailPrice).toBe(130);    // (b) retailPrice is the display price
    expect(found.priceCredits).toBe(130);   // (c) checkout↔display invariant
    expect(found.isPublished).toBe(true);
    expect(found.isActive).toBe(true);
  });

  it("unpublished external product is absent from listActiveProducts", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const now = new Date().toISOString();
    const id = uuidv4();
    db.run(
      `INSERT INTO products(id, kind, name, priceCredits, deliveryMode, isActive, isPublished,
         source, supplierSourceId, supplierProductId, supplierPrice, retailPrice, createdAt, updatedAt)
       VALUES(?, 'service', 'Hidden Ext', 130, 'admin_fulfill', 0, 0,
         'external_telegram_store', 'sup-1', 'sp-2', 100, 130, ?, ?)`,
      [id, now, now]
    );
    const { listActiveProducts } = await import("@/lib/db/repos/productsRepo.js");
    const active = await listActiveProducts();
    expect(active.find((p) => p.id === id)).toBeUndefined();
  });
});

// ─── AC5 regression: local products ───────────────────────────────────────────
describe("AC5 regression — local products unaffected", () => {
  it("listActiveProducts returns local isActive=1 product with null markup fields", async () => {
    const { createProduct, listActiveProducts } = await import("@/lib/db/repos/productsRepo.js");
    const local = await createProduct({
      kind: "service", name: "Local Active", priceCredits: 42, deliveryMode: "instant",
    });
    const active = await listActiveProducts();
    const found = active.find((p) => p.id === local.id);
    expect(found).toBeDefined();
    expect(found.priceCredits).toBe(42);
    expect(found.supplierPrice).toBeNull();
    expect(found.retailPrice).toBeNull();
    expect(found.isPublished).toBe(false);
  });

  it("updateProduct allows isActive on local products (story 2.28 not broken)", async () => {
    const { createProduct, updateProduct } = await import("@/lib/db/repos/productsRepo.js");
    const local = await createProduct({
      kind: "service", name: "Local Toggle", priceCredits: 10, deliveryMode: "instant",
    });
    const updated = await updateProduct(local.id, { isActive: false });
    expect(updated.isActive).toBe(false); // local CRUD still works
  });

  it("updateProduct rejects isActive on external products (Review CRITICAL #4)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const now = new Date().toISOString();
    const id = uuidv4();
    db.run(
      `INSERT INTO products(id, kind, name, priceCredits, deliveryMode, isActive, isPublished,
         source, supplierSourceId, supplierProductId, supplierPrice, createdAt, updatedAt)
       VALUES(?, 'service', 'Ext Guard', 100, 'admin_fulfill', 0, 0,
         'external_telegram_store', 'sup-1', 'sp-3', 100, ?, ?)`,
      [id, now, now]
    );
    const { updateProduct } = await import("@/lib/db/repos/productsRepo.js");
    await expect(updateProduct(id, { isActive: true })).rejects.toThrow(/publishProduct\/unpublishProduct/);
  });
});
