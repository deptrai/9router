// Story 2.34 (T7/AC3) — externalCheckout fail-closed gate tests.
// Covers: source 'unhealthy' → SUPPLIER_UNHEALTHY (no credit debit, no order),
//         source 'degraded' → checkout proceeds, source 'active' → proceeds (regression).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_ENC_KEY = "0".repeat(64);
const EXTERNAL_SOURCE = "external_telegram_store";

let tmpDir;
let getAdapter, createProduct, createUser, addCredits, getUserById,
  externalCheckout, ExternalCheckoutError, createSupplierSource;

async function loadModules() {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ createProduct } = await import("@/lib/db/repos/productsRepo.js"));
  ({ createUser, addCredits, getUserById } = await import("@/lib/db/repos/usersRepo.js"));
  ({ externalCheckout, ExternalCheckoutError } = await import("@/lib/store/externalCheckout.js"));
  ({ createSupplierSource } = await import("@/lib/db/repos/supplierSourcesRepo.js"));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-failclosed-"));
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

async function seedSource(overrides = {}) {
  return createSupplierSource({
    name: "Test Supplier",
    adapterType: "supplier_api",
    syncMode: "polling",
    auth: { apiUrl: "https://test.supplier/api", apiKey: "k" },
    ...overrides,
  });
}

async function setSourceStatus(sourceId, status) {
  const adapter = await getAdapter();
  adapter.run(`UPDATE supplierSources SET status=? WHERE id=?`, [status, sourceId]);
}

async function seedExternalProduct(sourceId, overrides = {}) {
  const adapter = await getAdapter();
  const product = await createProduct({
    kind: "service",
    name: "External Widget",
    priceCredits: 200,
    deliveryMode: "admin_fulfill",
    stock: null,
    isActive: true,
  });
  const now = new Date().toISOString();
  adapter.run(
    `UPDATE products SET source=?, supplierSourceId=?, supplierProductId=?,
     supplierPrice=?, retailPrice=?, expectedMargin=?, isPublished=?, priceCredits=?, updatedAt=?
     WHERE id=?`,
    [EXTERNAL_SOURCE, sourceId, "ext-prod-1", 150, 200, 50, 1, 200, now, product.id]
  );
  return adapter.get(`SELECT * FROM products WHERE id=?`, [product.id]);
}

async function seedUser(credits = 1000) {
  const u = await createUser("buyer@test.dev", "pass", "Buyer");
  if (credits > 0) {
    await addCredits(u.id, credits, null, { type: "admin_topup", idempotencyKey: `seed:${u.id}` });
  }
  return u;
}

describe("externalCheckout fail-closed gate (AC3)", () => {
  it("source unhealthy → throws SUPPLIER_UNHEALTHY, no credit debit, no order", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id);
    const user = await seedUser(1000);
    await setSourceStatus(source.id, "unhealthy");

    await expect(
      externalCheckout(user.id, product.id, { idempotencyKey: "fc-1" })
    ).rejects.toMatchObject({ code: "SUPPLIER_UNHEALTHY" });

    // Credit untouched
    const after = await getUserById(user.id);
    expect(after.creditsBalance).toBe(1000);
    // No order created
    const adapter = await getAdapter();
    const orders = adapter.all(`SELECT * FROM orders WHERE userId=?`, [user.id]);
    expect(orders).toHaveLength(0);
  });

  it("source degraded → checkout proceeds (1 transient fail, availability over zero-defect)", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id);
    const user = await seedUser(1000);
    await setSourceStatus(source.id, "degraded");

    const result = await externalCheckout(user.id, product.id, { idempotencyKey: "fc-2" });
    expect(result.order.status).toBe("paid");
    const after = await getUserById(user.id);
    expect(after.creditsBalance).toBe(800);
  });

  it("source active → checkout proceeds (regression)", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id);
    const user = await seedUser(1000);

    const result = await externalCheckout(user.id, product.id, { idempotencyKey: "fc-3" });
    expect(result.order.status).toBe("paid");
    expect(result.supplierOrder).not.toBeNull();
  });

  it("error is an ExternalCheckoutError instance", async () => {
    const source = await seedSource();
    const product = await seedExternalProduct(source.id);
    const user = await seedUser(1000);
    await setSourceStatus(source.id, "unhealthy");

    await expect(
      externalCheckout(user.id, product.id, { idempotencyKey: "fc-4" })
    ).rejects.toBeInstanceOf(ExternalCheckoutError);
  });
});
