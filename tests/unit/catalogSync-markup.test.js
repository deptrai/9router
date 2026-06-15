/**
 * Story 2.31 — catalogSync markup integration (T4/T7, AC3).
 * upsertExternalProduct stores supplierPrice (UPDATE path NEVER writes priceCredits directly);
 * INSERT path sets priceCredits = supplierPrice initial (not 0);
 * sync re-applies markup inline when a rule exists;
 * GUARD: sync (poll + applyWebhookEvent) NEVER touches isActive/isPublished — even when
 * the webhook event carries isActive.
 *
 * Adapter is mocked via the registry so no real network is hit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mockAdapter = vi.hoisted(() => ({
  validate: () => ({ ok: true }),
  fetchCatalog: vi.fn(async () => ({ products: [] })),
  normalizeProduct: (raw) => ({
    supplierProductId: String(raw.id ?? ""),
    name: raw.name ?? "Unnamed",
    priceCredits: Number(raw.price ?? 0),
    stock: raw.stock ?? null,
    description: raw.description ?? null,
    isActive: raw.isActive !== false,
  }),
}));

vi.mock("@/lib/store/suppliers/index.js", () => ({
  getAdapter: () => mockAdapter,
  REGISTRY: { supplier_api: mockAdapter, webhook: mockAdapter },
}));

let tmpDir;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-catalogsync-markup-"));
  process.env.DATA_DIR = tmpDir;
  process.env.STORE_ENC_KEY = "0".repeat(64);
  delete global._dbAdapter;
  vi.resetModules();
  mockAdapter.fetchCatalog.mockReset();
  mockAdapter.fetchCatalog.mockResolvedValue({ products: [] });
  const { getAdapter } = await import("@/lib/db/driver.js");
  await getAdapter();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makeSource(adapterType = "supplier_api", syncMode = "polling") {
  const { createSupplierSource } = await import("@/lib/db/repos/supplierSourcesRepo.js");
  return createSupplierSource({
    name: "Acme Supplier",
    adapterType,
    syncMode,
    auth: { apiUrl: "https://acme.test/api", apiKey: "k" },
  });
}

async function getProductBySupplierProductId(spid) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  return db.get(`SELECT * FROM products WHERE supplierProductId = ?`, [spid]);
}

describe("upsertExternalProduct — supplierPrice + priceCredits (AC3)", () => {
  it("INSERT: sets supplierPrice AND priceCredits = supplierPrice (not 0)", async () => {
    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({
      products: [{ id: "p1", name: "Prod 1", price: 80 }],
    });
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    const r = await syncSource(src.id);
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(1);

    const p = await getProductBySupplierProductId("p1");
    expect(p.supplierPrice).toBe(80);
    expect(p.priceCredits).toBe(80); // initial default = supplierPrice (NOT 0)
    expect(p.isActive).toBe(0);
    expect(p.isPublished).toBe(0);
    expect(p.retailPrice).toBeNull(); // no rule yet
  });

  it("UPDATE without rule: writes supplierPrice, leaves priceCredits unchanged", async () => {
    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "p1", name: "Prod 1", price: 80 }] });
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    await syncSource(src.id);

    // Second sync with a new supplier price; no markup rule exists.
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "p1", name: "Prod 1", price: 90 }] });
    await syncSource(src.id);

    const p = await getProductBySupplierProductId("p1");
    expect(p.supplierPrice).toBe(90); // updated
    // priceCredits NOT overwritten by UPDATE path (only applyMarkupToProduct sets it).
    // Initial insert set it to 80; no rule → stays 80.
    expect(p.priceCredits).toBe(80);
  });

  it("UPDATE with rule: re-applies markup inline → priceCredits = retailPrice", async () => {
    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "p1", name: "Prod 1", price: 80 }] });
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    await syncSource(src.id);

    // Add a supplier-level rule, then sync with a new price.
    const { createMarkupRule } = await import("@/lib/db/repos/markupRulesRepo.js");
    await createMarkupRule({ supplierId: src.id, markupPct: 25, roundingRule: "none" });

    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "p1", name: "Prod 1", price: 100 }] });
    await syncSource(src.id);

    const p = await getProductBySupplierProductId("p1");
    expect(p.supplierPrice).toBe(100);
    expect(p.retailPrice).toBe(125); // 100 * 1.25
    expect(p.priceCredits).toBe(125); // checkout reads retail
    expect(p.expectedMargin).toBe(25);
  });
});

describe("sync NEVER touches isActive/isPublished (QĐ6 guard)", () => {
  it("poll sync does not re-activate a published-then-unpublished product", async () => {
    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "p1", name: "Prod 1", price: 100 }] });
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    await syncSource(src.id);

    // Publish then unpublish (admin lock).
    const { createMarkupRule } = await import("@/lib/db/repos/markupRulesRepo.js");
    await createMarkupRule({ supplierId: src.id, markupPct: 20, roundingRule: "none" });
    const p0 = await getProductBySupplierProductId("p1");
    const { applyMarkupToProduct, publishProduct, unpublishProduct } = await import("@/lib/store/markupEngine.js");
    await applyMarkupToProduct(p0.id);
    await publishProduct(p0.id);
    await unpublishProduct(p0.id);

    // Sync again with a new price — must NOT touch isActive/isPublished.
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "p1", name: "Prod 1", price: 110 }] });
    await syncSource(src.id);

    const p = await getProductBySupplierProductId("p1");
    expect(p.isPublished).toBe(0); // admin lock respected
    expect(p.isActive).toBe(0);
    expect(p.supplierPrice).toBe(110); // price still refreshed
    expect(p.retailPrice).toBe(132); // 110 * 1.20 — re-priced
  });

  it("webhook event carrying isActive=false does NOT write isActive/isPublished", async () => {
    const src = await makeSource("webhook", "webhook");
    // Seed a product via a webhook insert first.
    const { applyWebhookEvent } = await import("@/lib/store/catalogSync.js");
    await applyWebhookEvent(src.id, { id: "w1", name: "WH Prod", price: 50, isActive: true });

    let p = await getProductBySupplierProductId("w1");
    expect(p.isActive).toBe(0); // insert always gates to 0
    expect(p.isPublished).toBe(0);

    // Now a webhook event tries to set isActive=false — must be ignored.
    await applyWebhookEvent(src.id, { id: "w1", name: "WH Prod", price: 60, isActive: false });
    p = await getProductBySupplierProductId("w1");
    expect(p.supplierPrice).toBe(60); // price refreshed
    expect(p.isActive).toBe(0); // unchanged — sync never writes isActive
    expect(p.isPublished).toBe(0);
  });
});

describe("local products NEVER touched (AC5 regression)", () => {
  it("sync does not affect local products", async () => {
    const { createProduct } = await import("@/lib/db/repos/productsRepo.js");
    const local = await createProduct({
      kind: "service", name: "Local Svc", priceCredits: 42, deliveryMode: "instant",
    });

    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "p1", name: "Prod 1", price: 80 }] });
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    await syncSource(src.id);

    const { getProductById } = await import("@/lib/db/repos/productsRepo.js");
    const after = await getProductById(local.id);
    expect(after.priceCredits).toBe(42);
    expect(after.source).toBe("local");
    expect(after.supplierPrice).toBeNull();
    expect(after.isActive).toBe(true);
  });
});
