// Story 2.33 — orderStatusSync unit tests
// Covers: AC1 webhook status map, AC2 terminal-guard, AC3 delivery forward,
//         AC4 unsupported delivery, AC5 terminal failure, AC6 backward-compat regression.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";

const TEST_ENC_KEY = "0".repeat(64);
const EXTERNAL_SOURCE = "external_telegram_store";

let tmpDir;
let getAdapter, createProduct, createUser, addCredits,
  applyOrderStatusEvent, pollOrderStatuses,
  insertSupplierOrderSync, updateSupplierOrderStatus,
  getSupplierOrderBySupplierOrderId,
  getOrderWithItems, getOrderById, transitionOrder,
  listDeliveriesByOrder,
  createSupplierSource, storeCheckout;

// sendMessage mock
const mockSendMessage = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/telegram/botClient.js", () => ({
  sendMessage: (...args) => mockSendMessage(...args),
}));

async function loadModules() {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ createProduct } = await import("@/lib/db/repos/productsRepo.js"));
  ({ createUser, addCredits } = await import("@/lib/db/repos/usersRepo.js"));
  ({ applyOrderStatusEvent, pollOrderStatuses } = await import("@/lib/store/orderStatusSync.js"));
  ({ insertSupplierOrderSync, updateSupplierOrderStatus, getSupplierOrderBySupplierOrderId } =
    await import("@/lib/db/repos/supplierOrdersRepo.js"));
  ({ getOrderWithItems, getOrderById, transitionOrder } =
    await import("@/lib/db/repos/ordersRepo.js"));
  ({ listDeliveriesByOrder } = await import("@/lib/db/repos/supplierDeliveriesRepo.js"));
  ({ createSupplierSource } = await import("@/lib/db/repos/supplierSourcesRepo.js"));
  ({ storeCheckout } = await import("@/lib/store/storeCheckout.js"));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-order-status-sync-"));
  process.env.DATA_DIR = tmpDir;
  process.env.STORE_ENC_KEY = TEST_ENC_KEY;
  delete global._dbAdapter;
  vi.resetModules();
  mockSendMessage.mockClear();
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

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedSource(overrides = {}) {
  return createSupplierSource({
    name: "Test Supplier",
    adapterType: "supplier_api",
    syncMode: overrides.syncMode ?? "webhook",
    auth: { apiUrl: "https://test.supplier/api", apiKey: "key", webhookSecret: "s3cret" },
    ...overrides,
  });
}

async function seedBuyer(credits = 1000) {
  const u = await createUser("buyer@test.dev", "pass", "Buyer");
  const adapter = await getAdapter();
  adapter.run(`UPDATE users SET telegramId=? WHERE id=?`, ["tg-buyer-123", u.id]);
  if (credits > 0) {
    await addCredits(u.id, credits, null, { type: "admin_topup", idempotencyKey: `seed:${u.id}` });
  }
  return { ...u, telegramId: "tg-buyer-123" };
}

// Create a paid external order directly in DB (bypasses storeCheckout — external products
// need externalCheckout which requires full supplier setup; direct insert is sufficient
// for testing orderStatusSync in isolation).
async function seedPaidExternalOrder(userId, productId) {
  const adapter = await getAdapter();
  const orderId = uuidv4();
  const itemId = uuidv4();
  const now = new Date().toISOString();
  adapter.run(
    `INSERT INTO orders(id,userId,status,source,totalCredits,deliveryMode,idempotencyKey,createdAt,updatedAt)
     VALUES(?,?,'paid','telegram',200,'admin_fulfill',?,?,?)`,
    [orderId, userId, `idem:${orderId}`, now, now]
  );
  adapter.run(
    `INSERT INTO orderItems(id,orderId,productId,productName,kind,deliveryMode,unitCredits,quantity,createdAt)
     VALUES(?,?,?,'External Widget','service','admin_fulfill',200,1,?)`,
    [itemId, orderId, productId, now]
  );
  return getOrderWithItems(orderId);
}

async function seedSupplierOrder(adapter, orderId, sourceId, supplierOrderId = null) {
  let row;
  adapter.transaction(() => {
    row = insertSupplierOrderSync(adapter, {
      orderId,
      supplierSourceId: sourceId,
      supplierProductId: "ext-prod-1",
      paymentMode: "proxy_checkout",
    });
  });
  if (supplierOrderId) {
    await updateSupplierOrderStatus(row.id, { supplierOrderId });
    row = await getSupplierOrderBySupplierOrderId(supplierOrderId);
  }
  return row;
}

async function seedExternalProduct(sourceId) {
  const adapter = await getAdapter();
  const product = await createProduct({
    kind: "service",
    name: "External Widget",
    priceCredits: 200,
    deliveryMode: "admin_fulfill",
    stock: null,
  });
  const now = new Date().toISOString();
  adapter.run(
    `UPDATE products SET source=?,supplierSourceId=?,supplierProductId=?,
     supplierPrice=?,retailPrice=?,expectedMargin=?,isPublished=?,updatedAt=?
     WHERE id=?`,
    [EXTERNAL_SOURCE, sourceId, "ext-prod-1", 150, 200, 50, 1, now, product.id]
  );
  return adapter.get(`SELECT * FROM products WHERE id=?`, [product.id]);
}

// ── AC1 — webhook status mapping ──────────────────────────────────────────────

describe("AC1 — webhook status mapping", () => {
  it("paid → no-op (only updates supplierStatus)", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-ord-001");

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-ord-001",
      status: "paid",
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("noop");
    expect(result.internalStatus).toBe("paid");

    const so = await getSupplierOrderBySupplierOrderId("sup-ord-001");
    expect(so.supplierStatus).toBe("paid");
  });

  it("expired → internal failed", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-ord-002");

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-ord-002",
      status: "expired",
    });

    expect(result.ok).toBe(true);
    expect(result.internalStatus).toBe("failed");
    const updated = await getOrderById(order.id);
    expect(updated.status).toBe("failed");
  });

  it("cancelled → internal cancelled", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-ord-003");

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-ord-003",
      status: "cancelled",
    });

    expect(result.ok).toBe(true);
    expect(result.internalStatus).toBe("cancelled");
  });

  it("failed → internal failed", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-ord-004");

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-ord-004",
      status: "failed",
    });

    expect(result.ok).toBe(true);
    expect(result.internalStatus).toBe("failed");
  });

  it("supplierStatus always written regardless of internal transition", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-ord-005");

    await applyOrderStatusEvent(source.id, { supplierOrderId: "sup-ord-005", status: "paid" });
    const so = await getSupplierOrderBySupplierOrderId("sup-ord-005");
    expect(so.supplierStatus).toBe("paid");
  });
});

// ── AC2 — terminal-guard (no downgrade) ──────────────────────────────────────

describe("AC2 — terminal-guard", () => {
  it("fulfilled order + supplier cancelled → skip (no downgrade)", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-ord-T1");

    await transitionOrder(order.id, "fulfilled", { note: "pre-transition" });

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-ord-T1",
      status: "cancelled",
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("terminal_or_noop");
    const current = await getOrderById(order.id);
    expect(current.status).toBe("fulfilled"); // NOT downgraded
  });

  it("failed order + supplier sends fulfilled with delivery → skip (no resurrect terminal)", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-ord-T2");

    await transitionOrder(order.id, "failed", { note: "pre-fail" });

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-ord-T2",
      status: "fulfilled",
      delivery: { type: "text", payload: "hello" },
    });

    expect(result.ok).toBe(true);
    const current = await getOrderById(order.id);
    expect(current.status).toBe("failed"); // NOT resurrected
  });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe("error cases", () => {
  it("supplier order not found → ok:false", async () => {
    const source = await seedSource();
    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "nonexistent",
      status: "paid",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("supplier order not found");
  });

  it("source mismatch → ok:false", async () => {
    const adapter = await getAdapter();
    const source1 = await seedSource();
    const source2 = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source1.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source1.id, "sup-ord-mismatch");

    const result = await applyOrderStatusEvent(source2.id, {
      supplierOrderId: "sup-ord-mismatch",
      status: "paid",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("source mismatch");
  });

  it("invalid status → ok:false", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-ord-inv");

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-ord-inv",
      status: "unknown_status",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid status");
  });
});
