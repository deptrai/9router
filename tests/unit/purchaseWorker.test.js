// Story 2-38.2 — purchaseWorker unit tests
// Covers: processAutoPurchase happy path, fallback, all-fail, lock guard,
//         runDuePurchases sweep, delivery forwarding, attempt audit.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_ENC_KEY = "0".repeat(64);
const EXTERNAL_SOURCE = "external_telegram_store";

// Mutable mock that purchaseProduct calls delegate to. Defined before vi.mock
// so the mock factory can close over it; tests set the implementation in beforeEach.
let purchaseProductImpl = vi.fn(() => ({ ok: false, error: "purchaseProduct not set" }));

vi.mock("@/lib/store/suppliers/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAdapter: vi.fn((type) => {
      if (type === "telegram_bot_scraper") {
        return {
          validate: vi.fn().mockReturnValue({ ok: true }),
          normalizeProduct: actual.REGISTRY[type]?.normalizeProduct,
          fetchCatalog: vi.fn(),
          purchaseProduct: async (...args) => purchaseProductImpl(...args),
        };
      }
      return actual.getAdapter(type);
    }),
  };
});

vi.mock("@/lib/telegram/botClient.js", () => ({
  sendMessage: vi.fn().mockResolvedValue(true),
}));

let tmpDir;
let getAdapter,
  createProduct,
  createUser,
  addCredits,
  updateUser,
  getUserById,
  createSupplierSource,
  storeCheckout,
  insertOrderWithItems,
  insertSupplierOrderSync,
  getOrderWithItems,
  getSupplierOrderByOrderId,
  listAttemptsByOrder,
  listDeliveriesByOrder,
  processAutoPurchase,
  runDuePurchases,
  createProductGroupId,
  sendMessage;

async function loadModules() {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  const productsRepo = await import("@/lib/db/repos/productsRepo.js");
  createProduct = productsRepo.createProduct;
  ({ createUser, addCredits, updateUser, getUserById } = await import("@/lib/db/repos/usersRepo.js"));
  ({ createSupplierSource } = await import("@/lib/db/repos/supplierSourcesRepo.js"));
  ({ storeCheckout } = await import("@/lib/store/storeCheckout.js"));
  const ordersRepo = await import("@/lib/db/repos/ordersRepo.js");
  insertOrderWithItems = ordersRepo.insertOrderWithItems;
  getOrderWithItems = ordersRepo.getOrderWithItems;
  const supplierOrdersRepo = await import("@/lib/db/repos/supplierOrdersRepo.js");
  insertSupplierOrderSync = supplierOrdersRepo.insertSupplierOrderSync;
  getSupplierOrderByOrderId = supplierOrdersRepo.getSupplierOrderByOrderId;
  ({ listAttemptsByOrder } = await import("@/lib/db/repos/supplierOrderAttemptsRepo.js"));
  ({ listDeliveriesByOrder } = await import("@/lib/db/repos/supplierDeliveriesRepo.js"));
  ({ processAutoPurchase, runDuePurchases } = await import("@/lib/store/purchaseWorker.js"));
  ({ createProductGroupId } = await import("@/lib/store/catalogSync.js"));
  ({ sendMessage } = await import("@/lib/telegram/botClient.js"));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-purchase-worker-"));
  process.env.DATA_DIR = tmpDir;
  process.env.STORE_ENC_KEY = TEST_ENC_KEY;
  delete global._dbAdapter;
  vi.resetModules();
  await loadModules();
  await getAdapter();

  purchaseProductImpl = vi.fn(() => ({ ok: false, error: "purchaseProduct not set" }));
  sendMessage.mockReset();
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
    name: "Test Bot",
    adapterType: "telegram_bot_scraper",
    syncMode: "polling",
    syncIntervalSec: 3600,
    paymentMode: "auto_fulfill",
    auth: {
      botUsername: "tainguyenvibebot",
      vndPerCredit: 1000,
      relayUrl: "http://127.0.0.1:3800/relay",
      relayToken: "token",
      command: "/products",
      purchaseCommand: "/buy",
    },
    ...overrides,
  });
}

async function seedExternalProduct(sourceId, groupId, overrides = {}) {
  const product = await createProduct({
    kind: "service",
    name: overrides.name ?? "External Widget",
    priceCredits: overrides.retailPrice ?? 200,
    deliveryMode: "admin_fulfill",
    stock: null,
  });
  const adapter = await getAdapter();
  const now = new Date().toISOString();
  const supplierPrice = overrides.supplierPrice ?? 150;
  const retailPrice = overrides.retailPrice ?? 200;
  adapter.run(
    `UPDATE products SET source=?, supplierSourceId=?, supplierProductId=?,
      supplierPrice=?, retailPrice=?, expectedMargin=?, isPublished=?,
      productGroupId=?, updatedAt=?
      WHERE id=?`,
    [
      EXTERNAL_SOURCE,
      sourceId,
      overrides.supplierProductId ?? "ext-prod-1",
      supplierPrice,
      retailPrice,
      retailPrice - supplierPrice,
      overrides.isPublished !== undefined ? (overrides.isPublished ? 1 : 0) : 1,
      groupId,
      now,
      product.id,
    ]
  );
  return adapter.get(`SELECT * FROM products WHERE id=?`, [product.id]);
}

async function seedUser(credits = 1000, telegramId = "12345") {
  const u = await createUser("buyer@test.dev", "pass", "Buyer");
  if (credits > 0) {
    await addCredits(u.id, credits, null, { type: "admin_topup", idempotencyKey: `seed:${u.id}` });
  }
  if (telegramId) {
    await updateUser(u.id, { telegramId });
  }
  return u;
}

async function seedPaidOrder(userId, productId, quantity = 1) {
  const { order } = await storeCheckout(userId, productId, {
    quantity,
    idempotencyKey: `test:${Date.now()}:${Math.random()}`,
  });
  return order;
}

function seedSupplierOrderSync(adapter, orderId, sourceId, product, overrides = {}) {
  return insertSupplierOrderSync(adapter, {
    orderId,
    supplierSourceId: sourceId,
    supplierProductId: product.supplierProductId,
    paymentMode: "auto_fulfill",
    supplierPrice: product.supplierPrice,
    retailPrice: product.retailPrice,
    expectedMargin: product.retailPrice - product.supplierPrice,
    supplierStatus: overrides.supplierStatus ?? "purchasing",
    purchaseLockExpiresAt: overrides.purchaseLockExpiresAt ?? null,
  });
}

// ───────────────────────────────────────────────────────────────────────────────

describe("processAutoPurchase", () => {
  it("returns error when order is not paid", async () => {
    const source = await seedSource();
    const groupId = createProductGroupId("External Widget");
    const product = await seedExternalProduct(source.id, groupId);
    const user = await seedUser();

    const adapter = await getAdapter();
    let order;
    adapter.transaction(() => {
      ({ order } = insertOrderWithItems(
        adapter,
        {
          userId: user.id,
          status: "pending",
          source: "telegram",
          totalCredits: product.retailPrice,
          deliveryMode: "admin_fulfill",
        },
        [
          {
            productId: product.id,
            productName: product.name,
            kind: product.kind,
            deliveryMode: "admin_fulfill",
            unitCredits: product.retailPrice,
            quantity: 1,
          },
        ]
      ));
      seedSupplierOrderSync(adapter, order.id, source.id, product);
    });

    const result = await processAutoPurchase(order.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/order not paid/i);
  });

  it("returns error when purchase is already locked", async () => {
    const source = await seedSource();
    const groupId = createProductGroupId("External Widget");
    const product = await seedExternalProduct(source.id, groupId);
    const user = await seedUser();
    const order = await seedPaidOrder(user.id, product.id);

    const adapter = await getAdapter();
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    seedSupplierOrderSync(adapter, order.id, source.id, product, {
      supplierStatus: "purchasing",
      purchaseLockExpiresAt: future,
    });

    const result = await processAutoPurchase(order.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/purchase already in progress/i);
  });

  it("succeeds on the first supplier, forwards delivery, and fulfills order", async () => {
    const source = await seedSource();
    const groupId = createProductGroupId("External Widget");
    const product = await seedExternalProduct(source.id, groupId);
    const user = await seedUser();
    const order = await seedPaidOrder(user.id, product.id);

    const adapter = await getAdapter();
    const supplierOrder = seedSupplierOrderSync(adapter, order.id, source.id, product);

    purchaseProductImpl.mockResolvedValue({
      ok: true,
      supplierOrderId: "sup-001",
      delivery: { type: "text", payload: "account: user / pass" },
    });

    const result = await processAutoPurchase(order.id);

    expect(result.ok).toBe(true);
    const updatedSo = await getSupplierOrderByOrderId(order.id);
    expect(updatedSo.supplierStatus).toBe("paid");
    expect(updatedSo.supplierOrderId).toBe("sup-001");
    expect(updatedSo.purchaseLockExpiresAt).toBeNull();

    const updatedOrder = await getOrderWithItems(order.id);
    expect(updatedOrder.status).toBe("fulfilled");
    expect(updatedOrder.fulfilledAt).not.toBeNull();

    const attempts = await listAttemptsByOrder(order.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("success");
    expect(attempts[0].supplierSourceId).toBe(source.id);

    const deliveries = await listDeliveriesByOrder(order.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("forwarded");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe("12345");
    expect(sendMessage.mock.calls[0][1]).toContain(order.id);
  });

  it("falls back to the next cheapest supplier when the first fails", async () => {
    const groupId = createProductGroupId("Shared Widget");

    const sourceA = await seedSource({ name: "Bot A" });
    const productA = await seedExternalProduct(sourceA.id, groupId, {
      name: "Shared Widget",
      supplierProductId: "prod-A",
      supplierPrice: 150,
    });

    const sourceB = await seedSource({ name: "Bot B" });
    await seedExternalProduct(sourceB.id, groupId, {
      name: "Shared Widget",
      supplierProductId: "prod-B",
      supplierPrice: 160,
    });

    const user = await seedUser();
    const order = await seedPaidOrder(user.id, productA.id);

    const adapter = await getAdapter();
    seedSupplierOrderSync(adapter, order.id, sourceA.id, productA);

    purchaseProductImpl.mockImplementation(async (_source, _auth, product) => {
      if (product.supplierSourceId === sourceA.id) {
        return { ok: false, error: "out of stock at A" };
      }
      return { ok: true, supplierOrderId: "sup-B", delivery: { type: "text", payload: "ok" } };
    });

    const result = await processAutoPurchase(order.id);
    expect(result.ok).toBe(true);

    const updatedSo = await getSupplierOrderByOrderId(order.id);
    expect(updatedSo.supplierSourceId).toBe(sourceB.id);
    expect(updatedSo.supplierProductId).toBe("prod-B");
    expect(updatedSo.supplierStatus).toBe("paid");

    const updatedOrder = await getOrderWithItems(order.id);
    expect(updatedOrder.status).toBe("fulfilled");

    const attempts = await listAttemptsByOrder(order.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[1].status).toBe("success");

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("marks order failed and notifies buyer when all suppliers fail", async () => {
    const groupId = createProductGroupId("Shared Widget");

    const sourceA = await seedSource({ name: "Bot A" });
    const productA = await seedExternalProduct(sourceA.id, groupId, {
      name: "Shared Widget",
      supplierProductId: "prod-A",
      supplierPrice: 150,
    });

    const sourceB = await seedSource({ name: "Bot B" });
    await seedExternalProduct(sourceB.id, groupId, {
      name: "Shared Widget",
      supplierProductId: "prod-B",
      supplierPrice: 160,
    });

    const user = await seedUser();
    const order = await seedPaidOrder(user.id, productA.id);

    const adapter = await getAdapter();
    seedSupplierOrderSync(adapter, order.id, sourceA.id, productA);

    purchaseProductImpl.mockResolvedValue({ ok: false, error: "supplier unavailable" });

    const result = await processAutoPurchase(order.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/all supplier attempts failed/i);

    const updatedSo = await getSupplierOrderByOrderId(order.id);
    expect(updatedSo.supplierStatus).toBe("failed");
    expect(updatedSo.purchaseLockExpiresAt).toBeNull();

    const updatedOrder = await getOrderWithItems(order.id);
    expect(updatedOrder.status).toBe("failed");

    const attempts = await listAttemptsByOrder(order.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.status === "failed")).toBe(true);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatch(/liên hệ/i);
  });
});

describe("runDuePurchases", () => {
  it("picks up a stuck auto_fulfill order with an expired lock and processes it", async () => {
    const source = await seedSource();
    const groupId = createProductGroupId("External Widget");
    const product = await seedExternalProduct(source.id, groupId);
    const user = await seedUser();
    const order = await seedPaidOrder(user.id, product.id);

    const adapter = await getAdapter();
    const past = new Date(Date.now() - 1000).toISOString();
    seedSupplierOrderSync(adapter, order.id, source.id, product, {
      supplierStatus: "purchasing",
      purchaseLockExpiresAt: past,
    });

    purchaseProductImpl.mockResolvedValue({
      ok: true,
      supplierOrderId: "sup-sweep",
      delivery: { type: "text", payload: "sweep ok" },
    });

    const result = await runDuePurchases();
    expect(result.processed).toBe(1);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[0].orderId).toBe(order.id);

    const updatedOrder = await getOrderWithItems(order.id);
    expect(updatedOrder.status).toBe("fulfilled");

    const updatedSo = await getSupplierOrderByOrderId(order.id);
    expect(updatedSo.supplierStatus).toBe("paid");
  });
});
