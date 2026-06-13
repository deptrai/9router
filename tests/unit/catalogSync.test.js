/**
 * Story 2.30 — catalogSync engine (T4, AC3/AC4/AC5/AC6).
 * syncSource upsert+dedup+syncVersion bump; webhook apply; stale detection;
 * fail→recordSyncFailure (degraded); local products NEVER touched (AC6 regression).
 *
 * Adapter is mocked via the registry so no real network is hit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Controllable fake adapter (hoisted so vi.mock can capture it).
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
  REGISTRY: { supplier_api: mockAdapter },
}));

let tmpDir;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-catalogsync-"));
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

async function makeSource() {
  const { createSupplierSource } = await import("@/lib/db/repos/supplierSourcesRepo.js");
  return createSupplierSource({
    name: "Acme Supplier",
    adapterType: "supplier_api",
    syncMode: "polling",
    auth: { apiUrl: "https://acme.test/api", apiKey: "k" },
  });
}

async function allProducts() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  return db.all(`SELECT * FROM products`);
}

describe("syncSource — upsert + dedup + syncVersion (AC4)", () => {
  it("inserts external products, source=external, isActive=0, syncVersion=1", async () => {
    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({
      products: [{ id: "p1", name: "Prod 1", price: 10 }, { id: "p2", name: "Prod 2", price: 20 }],
    });
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    const r = await syncSource(src.id);

    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(2);
    expect(r.syncVersion).toBe(1);

    const prods = await allProducts();
    expect(prods).toHaveLength(2);
    for (const p of prods) {
      expect(p.source).toBe("external_telegram_store");
      expect(p.supplierSourceId).toBe(src.id);
      expect(p.isActive).toBe(0); // not sellable until 2.31 (QĐ7)
      expect(p.syncVersion).toBe(1);
      expect(p.lastSyncedAt).toBeTruthy();
    }
  });

  it("re-sync dedups by supplierProductId (update, not duplicate) + bumps syncVersion", async () => {
    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "p1", name: "Prod 1", price: 10 }] });
    const { syncSource } = await import("@/lib/store/catalogSync.js");

    await syncSource(src.id);
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "p1", name: "Prod 1 RENAMED", price: 15 }] });
    const r2 = await syncSource(src.id);

    expect(r2.updated).toBe(1);
    expect(r2.inserted).toBe(0);
    expect(r2.syncVersion).toBe(2);

    const prods = await allProducts();
    expect(prods).toHaveLength(1);
    expect(prods[0].name).toBe("Prod 1 RENAMED");
    expect(prods[0].priceCredits).toBe(15);
    expect(prods[0].syncVersion).toBe(2);
  });

  it("skips rows without supplierProductId", async () => {
    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ name: "no id" }, { id: "ok", name: "Has id" }] });
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    const r = await syncSource(src.id);
    expect(r.inserted).toBe(1);
    expect((await allProducts())).toHaveLength(1);
  });
});

describe("syncSource — fail-soft → degraded (AC5)", () => {
  it("adapter fetchCatalog error → recordSyncFailure, status degraded, no throw", async () => {
    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [], error: "HTTP 503" });
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    const { getSupplierSourceById } = await import("@/lib/db/repos/supplierSourcesRepo.js");

    const r = await syncSource(src.id);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("HTTP 503");

    const after = await getSupplierSourceById(src.id);
    expect(after.status).toBe("degraded");
    expect(after.lastSyncError).toBe("HTTP 503");
  });

  it("second consecutive failure → unhealthy", async () => {
    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [], error: "boom" });
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    const { getSupplierSourceById } = await import("@/lib/db/repos/supplierSourcesRepo.js");

    await syncSource(src.id);
    await syncSource(src.id);
    const after = await getSupplierSourceById(src.id);
    expect(after.status).toBe("unhealthy");
  });

  it("success after failure heals to active", async () => {
    const src = await makeSource();
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    const { getSupplierSourceById } = await import("@/lib/db/repos/supplierSourcesRepo.js");

    mockAdapter.fetchCatalog.mockResolvedValue({ products: [], error: "boom" });
    await syncSource(src.id);
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "p1", name: "ok" }] });
    await syncSource(src.id);

    const after = await getSupplierSourceById(src.id);
    expect(after.status).toBe("active");
    expect(after.lastSyncError).toBeNull();
  });
});

describe("applyWebhookEvent (AC3)", () => {
  it("upserts a single product from a push event + bumps syncVersion", async () => {
    const src = await makeSource();
    const { applyWebhookEvent } = await import("@/lib/store/catalogSync.js");

    const r = await applyWebhookEvent(src.id, { id: "wp1", name: "Webhook Prod", price: 5 });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("inserted");

    const prods = await allProducts();
    expect(prods).toHaveLength(1);
    expect(prods[0].supplierProductId).toBe("wp1");
    expect(prods[0].source).toBe("external_telegram_store");
  });

  it("rejects event missing supplierProductId", async () => {
    const src = await makeSource();
    const { applyWebhookEvent } = await import("@/lib/store/catalogSync.js");
    const r = await applyWebhookEvent(src.id, { name: "no id" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/supplierProductId/);
  });
});

describe("isProductStale (AC4)", () => {
  it("external product synced long ago → stale; recent → fresh", async () => {
    const { isProductStale, EXTERNAL_SOURCE } = await import("@/lib/store/catalogSync.js");
    const old = { source: EXTERNAL_SOURCE, lastSyncedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() };
    const fresh = { source: EXTERNAL_SOURCE, lastSyncedAt: new Date().toISOString() };
    expect(isProductStale(old, 24 * 3600)).toBe(true);
    expect(isProductStale(fresh, 24 * 3600)).toBe(false);
  });

  it("external product never synced → stale", async () => {
    const { isProductStale, EXTERNAL_SOURCE } = await import("@/lib/store/catalogSync.js");
    expect(isProductStale({ source: EXTERNAL_SOURCE, lastSyncedAt: null })).toBe(true);
  });

  it("local product is NEVER stale (AC6)", async () => {
    const { isProductStale } = await import("@/lib/store/catalogSync.js");
    expect(isProductStale({ source: "local", lastSyncedAt: null })).toBe(false);
  });
});

describe("AC6 — local products untouched by sync", () => {
  it("createProduct local survives sync; sync only adds external", async () => {
    const { createProduct, listActiveProducts } = await import("@/lib/db/repos/productsRepo.js");
    const local = await createProduct({
      kind: "service", name: "Local Service", priceCredits: 100, deliveryMode: "instant",
    });
    expect(local.source).toBe("local");

    const src = await makeSource();
    mockAdapter.fetchCatalog.mockResolvedValue({ products: [{ id: "ext1", name: "Ext", price: 1 }] });
    const { syncSource } = await import("@/lib/store/catalogSync.js");
    await syncSource(src.id);

    // Local product unchanged, still active + in catalog.
    const active = await listActiveProducts();
    const stillLocal = active.find(p => p.id === local.id);
    expect(stillLocal).toBeTruthy();
    expect(stillLocal.source).toBe("local");
    expect(stillLocal.supplierSourceId).toBeNull();

    // External product exists but isActive=0 → NOT in active catalog (QĐ7 gate).
    expect(active.find(p => p.supplierProductId === "ext1")).toBeUndefined();
  });
});
