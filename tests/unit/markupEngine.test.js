/**
 * Story 2.31 — markupEngine (T3/T7, AC1/AC2/AC3/AC4).
 * calculateRetailPrice pure function (rounding rules, markupPct<=0 reject, BP-6 6-decimal);
 * applyMarkupToProduct inline-transaction (db adapter, no nesting);
 * publishProduct validate pricing + invariant isPublished⇒isActive + error-path;
 * unpublishProduct; getEffectivePrice fallback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";

let tmpDir;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-markupengine-"));
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

// ─── Helpers ────────────────────────────────────────────────────────────────
async function insertExternalProduct(overrides = {}) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  const id = overrides.id ?? uuidv4();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO products(id, kind, name, description, priceCredits, deliveryMode,
       targetType, targetId, stock, isActive, isPublished, source, supplierSourceId,
       supplierProductId, supplierPrice, retailPrice, expectedMargin, syncVersion, lastSyncedAt, createdAt, updatedAt)
     VALUES(?, 'service', ?, NULL, ?, 'admin_fulfill', NULL, NULL, NULL, ?, ?, 'external_telegram_store', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      id,
      overrides.name ?? "Ext Prod",
      overrides.priceCredits ?? 100,
      overrides.isActive ?? 0,
      overrides.isPublished ?? 0,
      overrides.supplierSourceId ?? "sup-1",
      overrides.supplierProductId ?? "sp-1",
      "supplierPrice" in overrides ? overrides.supplierPrice : 100,
      overrides.retailPrice ?? null,
      overrides.expectedMargin ?? null,
      now,
      now,
      now,
    ]
  );
  return id;
}

async function createRule(data) {
  const { createMarkupRule } = await import("@/lib/db/repos/markupRulesRepo.js");
  return createMarkupRule(data);
}

async function getProduct(id) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  return db.get(`SELECT * FROM products WHERE id = ?`, [id]);
}

// ─── calculateRetailPrice (pure function) ─────────────────────────────────────
describe("calculateRetailPrice — pure function (AC1/AC4)", () => {
  it("computes retailPrice = supplierPrice * (1 + markupPct/100)", async () => {
    const { calculateRetailPrice } = await import("@/lib/store/markupEngine.js");
    expect(calculateRetailPrice(100, 20, "none")).toBe(120);
    expect(calculateRetailPrice(50, 10, "none")).toBe(55);
  });

  it("applies rounding rules: ceil/floor/round", async () => {
    const { calculateRetailPrice } = await import("@/lib/store/markupEngine.js");
    // 100 * 1.155 = 115.5
    expect(calculateRetailPrice(100, 15.5, "ceil")).toBe(116);
    expect(calculateRetailPrice(100, 15.5, "floor")).toBe(115);
    expect(calculateRetailPrice(100, 15.5, "round")).toBe(116);
    // 100 * 1.154 = 115.4 → round = 115
    expect(calculateRetailPrice(100, 15.4, "round")).toBe(115);
  });

  it("BP-6: rounds to 6 decimals even when roundingRule='none' (float drift guard)", async () => {
    const { calculateRetailPrice } = await import("@/lib/store/markupEngine.js");
    // 14.999999999999998 style drift → clean value
    const r = calculateRetailPrice(10, 50, "none"); // 10*1.5 = 15
    expect(r).toBe(15);
    // ensure no long float tail
    const r2 = calculateRetailPrice(33.33, 10, "none"); // 36.663
    expect(r2).toBe(36.663);
    expect(Number.isFinite(r2)).toBe(true);
  });

  it("rejects markupPct <= 0 (AC4: margin dương bắt buộc)", async () => {
    const { calculateRetailPrice } = await import("@/lib/store/markupEngine.js");
    expect(() => calculateRetailPrice(100, 0, "none")).toThrow(/markupPct/);
    expect(() => calculateRetailPrice(100, -5, "none")).toThrow(/markupPct/);
  });

  it("rejects invalid supplierPrice", async () => {
    const { calculateRetailPrice } = await import("@/lib/store/markupEngine.js");
    expect(() => calculateRetailPrice(-1, 10, "none")).toThrow(/supplierPrice/);
    expect(() => calculateRetailPrice(NaN, 10, "none")).toThrow(/supplierPrice/);
  });
});

// ─── applyMarkupToProduct ─────────────────────────────────────────────────────
describe("applyMarkupToProduct — rule lookup + persist (AC1/AC3)", () => {
  it("applies product-level rule, sets retailPrice/expectedMargin/priceCredits", async () => {
    const id = await insertExternalProduct({ supplierPrice: 100, priceCredits: 100 });
    await createRule({ productId: id, markupPct: 25, roundingRule: "none" });
    const { applyMarkupToProduct } = await import("@/lib/store/markupEngine.js");
    const result = await applyMarkupToProduct(id);
    expect(result).toEqual({ retailPrice: 125, expectedMargin: 25 });

    const p = await getProduct(id);
    expect(p.retailPrice).toBe(125);
    expect(p.expectedMargin).toBe(25);
    expect(p.priceCredits).toBe(125); // checkout reads priceCredits
  });

  it("returns null when no applicable rule (priceCredits untouched)", async () => {
    const id = await insertExternalProduct({ supplierPrice: 100, priceCredits: 100 });
    const { applyMarkupToProduct } = await import("@/lib/store/markupEngine.js");
    const result = await applyMarkupToProduct(id);
    expect(result).toBeNull();
    const p = await getProduct(id);
    expect(p.priceCredits).toBe(100); // unchanged
    expect(p.retailPrice).toBeNull();
  });

  it("inline mode (db adapter passed) runs synchronously without nesting transaction", async () => {
    const id = await insertExternalProduct({ supplierPrice: 200, priceCredits: 200 });
    await createRule({ productId: id, markupPct: 10, roundingRule: "none" });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { applyMarkupToProduct } = await import("@/lib/store/markupEngine.js");
    const db = await getAdapter();
    // Caller owns the transaction; applyMarkupToProduct(id, db) must run inline.
    db.transaction(() => {
      const r = applyMarkupToProduct(id, db);
      expect(r).toEqual({ retailPrice: 220, expectedMargin: 20 });
    });
    const p = await getProduct(id);
    expect(p.retailPrice).toBe(220);
    expect(p.priceCredits).toBe(220);
  });

  it("does NOT touch isActive/isPublished", async () => {
    const id = await insertExternalProduct({ supplierPrice: 100, priceCredits: 100, isActive: 0, isPublished: 0 });
    await createRule({ productId: id, markupPct: 50, roundingRule: "none" });
    const { applyMarkupToProduct } = await import("@/lib/store/markupEngine.js");
    await applyMarkupToProduct(id);
    const p = await getProduct(id);
    expect(p.isActive).toBe(0);
    expect(p.isPublished).toBe(0);
  });

  it("throws when supplierPrice is null", async () => {
    const id = await insertExternalProduct({ supplierPrice: null, priceCredits: 0 });
    await createRule({ productId: id, markupPct: 10, roundingRule: "none" });
    const { applyMarkupToProduct } = await import("@/lib/store/markupEngine.js");
    await expect(applyMarkupToProduct(id)).rejects.toThrow(/supplierPrice/);
  });
});

// ─── publishProduct / unpublishProduct ────────────────────────────────────────
describe("publishProduct — validate pricing + invariant (AC2)", () => {
  it("publishes when pricing is set: isPublished=1 AND isActive=1", async () => {
    const id = await insertExternalProduct({ supplierPrice: 100, retailPrice: 130, priceCredits: 130 });
    const { publishProduct } = await import("@/lib/store/markupEngine.js");
    await publishProduct(id);
    const p = await getProduct(id);
    expect(p.isPublished).toBe(1);
    expect(p.isActive).toBe(1);
  });

  it("error-path: rejects when supplierPrice is null", async () => {
    const id = await insertExternalProduct({ supplierPrice: null, retailPrice: 130, priceCredits: 130 });
    const { publishProduct } = await import("@/lib/store/markupEngine.js");
    await expect(publishProduct(id)).rejects.toThrow(/supplierPrice/);
    const p = await getProduct(id);
    expect(p.isPublished).toBe(0); // unchanged
  });

  it("error-path: rejects when retailPrice is null (markup chưa apply)", async () => {
    const id = await insertExternalProduct({ supplierPrice: 100, retailPrice: null, priceCredits: 100 });
    const { publishProduct } = await import("@/lib/store/markupEngine.js");
    await expect(publishProduct(id)).rejects.toThrow(/retailPrice/);
    const p = await getProduct(id);
    expect(p.isPublished).toBe(0);
  });
});

describe("unpublishProduct — admin lock (AC3)", () => {
  it("sets isPublished=0 AND isActive=0", async () => {
    const id = await insertExternalProduct({ supplierPrice: 100, retailPrice: 130, priceCredits: 130, isActive: 1, isPublished: 1 });
    const { unpublishProduct } = await import("@/lib/store/markupEngine.js");
    await unpublishProduct(id);
    const p = await getProduct(id);
    expect(p.isPublished).toBe(0);
    expect(p.isActive).toBe(0);
  });
});

// ─── getEffectivePrice ────────────────────────────────────────────────────────
describe("getEffectivePrice — display fallback", () => {
  it("prefers retailPrice when set", async () => {
    const { getEffectivePrice } = await import("@/lib/store/markupEngine.js");
    expect(getEffectivePrice({ retailPrice: 130, priceCredits: 100 })).toBe(130);
  });

  it("falls back to priceCredits when retailPrice null", async () => {
    const { getEffectivePrice } = await import("@/lib/store/markupEngine.js");
    expect(getEffectivePrice({ retailPrice: null, priceCredits: 100 })).toBe(100);
    expect(getEffectivePrice({ priceCredits: 100 })).toBe(100);
  });
});
