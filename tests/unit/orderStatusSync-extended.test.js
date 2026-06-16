// Story 2.33 — orderStatusSync extended tests (coverage gaps)
// Covers: forward_failed path, buyer-no-telegramId graceful skip, notifyBuyer null-user fail-safe
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";

const TEST_ENC_KEY = "0".repeat(64);
const EXTERNAL_SOURCE = "external_telegram_store";

let tmpDir;
let getAdapter, createProduct, createUser, addCredits,
  applyOrderStatusEvent,
  insertSupplierOrderSync, updateSupplierOrderStatus,
  getSupplierOrderBySupplierOrderId,
  getOrderWithItems, getOrderById,
  listDeliveriesByOrder,
  createSupplierSource;

const mockSendMessage = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/telegram/botClient.js", () => ({
  sendMessage: (...args) => mockSendMessage(...args),
}));

async function loadModules() {
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ createProduct } = await import("@/lib/db/repos/productsRepo.js"));
  ({ createUser, addCredits } = await import("@/lib/db/repos/usersRepo.js"));
  ({ applyOrderStatusEvent } = await import("@/lib/store/orderStatusSync.js"));
  ({ insertSupplierOrderSync, updateSupplierOrderStatus, getSupplierOrderBySupplierOrderId } =
    await import("@/lib/db/repos/supplierOrdersRepo.js"));
  ({ getOrderWithItems, getOrderById } =
    await import("@/lib/db/repos/ordersRepo.js"));
  ({ listDeliveriesByOrder } = await import("@/lib/db/repos/supplierDeliveriesRepo.js"));
  ({ createSupplierSource } = await import("@/lib/db/repos/supplierSourcesRepo.js"));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-order-status-sync-ext-"));
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

// ── Seed helpers (mirrors orderStatusSync.test.js) ────────────────────────────

async function seedSource(overrides = {}) {
  return createSupplierSource({
    name: "Test Supplier",
    adapterType: "supplier_api",
    syncMode: overrides.syncMode ?? "webhook",
    auth: { apiUrl: "https://test.supplier/api", apiKey: "key", webhookSecret: "s3cret" },
    ...overrides,
  });
}

async function seedBuyer({ withTelegramId = true, credits = 1000 } = {}) {
  const u = await createUser("buyer@test.dev", "pass", "Buyer");
  const adapter = await getAdapter();
  if (withTelegramId) {
    adapter.run(`UPDATE users SET telegramId=? WHERE id=?`, ["tg-buyer-123", u.id]);
  }
  if (credits > 0) {
    await addCredits(u.id, credits, null, { type: "admin_topup", idempotencyKey: `seed:${u.id}` });
  }
  return { ...u, telegramId: withTelegramId ? "tg-buyer-123" : null };
}

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

// ── P1: forward_failed path ───────────────────────────────────────────────────
//
// When sendMessage throws after a successful delivery forward, the function
// must not propagate the error (best-effort QĐ7). The delivery audit row must
// already be written as "forwarded" (inside the transaction, before sendMessage).

describe("P1 — forward_failed / sendMessage throws post-commit", () => {
  it("sendMessage failure does not throw — result still ok:true, forwarded:true", async () => {
    mockSendMessage.mockRejectedValueOnce(new Error("Telegram timeout"));

    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-fwd-fail-01");

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-fwd-fail-01",
      status: "fulfilled",
      delivery: { type: "text", payload: "code-XYZ" },
    });

    // Give async notification time to settle
    await new Promise(r => setTimeout(r, 50));

    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);
    expect(result.internalStatus).toBe("fulfilled");
  });

  it("delivery audit row is 'forwarded' even when sendMessage throws", async () => {
    mockSendMessage.mockRejectedValueOnce(new Error("Telegram timeout"));

    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-fwd-fail-02");

    await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-fwd-fail-02",
      status: "fulfilled",
      delivery: { type: "text", payload: "code-ABC" },
    });

    await new Promise(r => setTimeout(r, 50));

    const deliveries = await listDeliveriesByOrder(order.id);
    expect(deliveries.some(d => d.status === "forwarded")).toBe(true);

    const updated = await getOrderById(order.id);
    expect(updated.status).toBe("fulfilled");
  });

  it("sendMessage returns ok:false — result still ok:true, forwarded:true (best-effort)", async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: false, description: "blocked" });

    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer();
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-fwd-fail-03");

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-fwd-fail-03",
      status: "fulfilled",
      delivery: { type: "text", payload: "code-DEF" },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);
  });
});

// ── P2: buyer has no telegramId — delivery forward skips sendMessage ──────────

describe("P2 — buyer has no telegramId", () => {
  it("fulfilled delivery: order still fulfilled, audit forwarded, sendMessage NOT called", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer({ withTelegramId: false });
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-notg-01");

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-notg-01",
      status: "fulfilled",
      delivery: { type: "text", payload: "code-notg" },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);
    expect(result.internalStatus).toBe("fulfilled");

    // sendMessage must NOT be called — no telegramId to deliver to
    expect(mockSendMessage).not.toHaveBeenCalled();

    const updated = await getOrderById(order.id);
    expect(updated.status).toBe("fulfilled");

    const deliveries = await listDeliveriesByOrder(order.id);
    expect(deliveries.some(d => d.status === "forwarded")).toBe(true);
  });

  it("failed status: order still transitions to failed, sendMessage NOT called", async () => {
    const adapter = await getAdapter();
    const source = await seedSource();
    const buyer = await seedBuyer({ withTelegramId: false });
    const product = await seedExternalProduct(source.id);
    const order = await seedPaidExternalOrder(buyer.id, product.id);
    await seedSupplierOrder(adapter, order.id, source.id, "sup-notg-02");

    const result = await applyOrderStatusEvent(source.id, {
      supplierOrderId: "sup-notg-02",
      status: "failed",
    });

    await new Promise(r => setTimeout(r, 50));

    expect(result.ok).toBe(true);
    expect(result.internalStatus).toBe("failed");
    expect(mockSendMessage).not.toHaveBeenCalled();

    const updated = await getOrderById(order.id);
    expect(updated.status).toBe("failed");
  });
});
