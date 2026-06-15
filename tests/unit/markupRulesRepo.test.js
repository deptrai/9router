/**
 * Story 2.31 — markupRulesRepo (T2/T7, AC1/AC4).
 * create/validate/enum guard, priority lookup (product > supplier > global —
 * NO category tier), updateRule, deleteRule.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir, repo, getAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-markuprules-"));
  process.env.DATA_DIR = tmpDir;
  process.env.STORE_ENC_KEY = "0".repeat(64);
  delete global._dbAdapter;
  vi.resetModules();
  repo = await import("@/lib/db/repos/markupRulesRepo.js");
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  await getAdapter();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createMarkupRule — validate + enum (AC1/AC4)", () => {
  it("exports ROUNDING_RULES enum", () => {
    expect(repo.ROUNDING_RULES).toEqual(["none", "ceil", "floor", "round"]);
  });

  it("creates a product-level rule", async () => {
    const r = await repo.createMarkupRule({ productId: "p1", markupPct: 20, roundingRule: "ceil" });
    expect(r.productId).toBe("p1");
    expect(r.markupPct).toBe(20);
    expect(r.roundingRule).toBe("ceil");
    expect(r.isActive).toBe(true);
  });

  it("creates a global rule (both null)", async () => {
    const r = await repo.createMarkupRule({ markupPct: 15 });
    expect(r.supplierId).toBeNull();
    expect(r.productId).toBeNull();
    expect(r.roundingRule).toBe("none");
  });

  it("rejects markupPct <= 0 (AC4)", async () => {
    await expect(repo.createMarkupRule({ productId: "p1", markupPct: 0 })).rejects.toThrow(/markupPct/);
    await expect(repo.createMarkupRule({ productId: "p1", markupPct: -10 })).rejects.toThrow(/markupPct/);
  });

  it("rejects invalid roundingRule", async () => {
    await expect(repo.createMarkupRule({ productId: "p1", markupPct: 10, roundingRule: "bogus" })).rejects.toThrow(/roundingRule/);
  });
});

describe("findApplicableRule — priority lookup (AC1)", () => {
  it("product-level beats supplier-level and global", async () => {
    await repo.createMarkupRule({ markupPct: 5 });                          // global
    await repo.createMarkupRule({ supplierId: "s1", markupPct: 10 });       // supplier
    await repo.createMarkupRule({ productId: "p1", markupPct: 30 });        // product
    const db = await getAdapter();
    const rule = repo.findApplicableRule(db, "p1", "s1");
    expect(rule.markupPct).toBe(30);
  });

  it("supplier-level beats global when no product rule", async () => {
    await repo.createMarkupRule({ markupPct: 5 });                          // global
    await repo.createMarkupRule({ supplierId: "s1", markupPct: 10 });       // supplier
    const db = await getAdapter();
    const rule = repo.findApplicableRule(db, "p1", "s1");
    expect(rule.markupPct).toBe(10);
  });

  it("falls back to global when no product/supplier rule", async () => {
    await repo.createMarkupRule({ markupPct: 5 });
    const db = await getAdapter();
    const rule = repo.findApplicableRule(db, "p-unknown", "s-unknown");
    expect(rule.markupPct).toBe(5);
  });

  it("returns null when no rule matches at all", async () => {
    const db = await getAdapter();
    const rule = repo.findApplicableRule(db, "p1", "s1");
    expect(rule).toBeNull();
  });

  it("ignores inactive rules", async () => {
    const r = await repo.createMarkupRule({ productId: "p1", markupPct: 30 });
    await repo.updateMarkupRule(r.id, { isActive: false });
    const db = await getAdapter();
    const rule = repo.findApplicableRule(db, "p1", "s1");
    expect(rule).toBeNull();
  });
});

describe("updateMarkupRule / deleteMarkupRule", () => {
  it("updates markupPct with validation", async () => {
    const r = await repo.createMarkupRule({ productId: "p1", markupPct: 10 });
    const updated = await repo.updateMarkupRule(r.id, { markupPct: 25 });
    expect(updated.markupPct).toBe(25);
  });

  it("rejects update with markupPct <= 0", async () => {
    const r = await repo.createMarkupRule({ productId: "p1", markupPct: 10 });
    await expect(repo.updateMarkupRule(r.id, { markupPct: 0 })).rejects.toThrow(/markupPct/);
  });

  it("deletes a rule", async () => {
    const r = await repo.createMarkupRule({ productId: "p1", markupPct: 10 });
    const res = await repo.deleteMarkupRule(r.id);
    expect(res.deleted).toBe(true);
    expect(await repo.getMarkupRuleById(r.id)).toBeNull();
  });

  it("listMarkupRules returns created rules", async () => {
    await repo.createMarkupRule({ productId: "p1", markupPct: 10 });
    await repo.createMarkupRule({ supplierId: "s1", markupPct: 20 });
    const all = await repo.listMarkupRules();
    expect(all).toHaveLength(2);
  });
});
