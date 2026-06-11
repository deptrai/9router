// Story 2.26 — storeCheckout atomic purchase (credit-paid Telegram Store)
// Verifies: happy path debit+order, oversell guard, insufficient credits,
// idempotent replay, inactive/missing product, instant fulfillment.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

// Modules are re-imported per test so they bind to the fresh per-test adapter.
let storeCheckout, CheckoutError, createProduct, createUser, addCredits, getUserById, getAdapter, listOrdersByUser;

async function loadModules() {
  ({ storeCheckout, CheckoutError } = await import("@/lib/store/storeCheckout.js"));
  ({ createProduct } = await import("@/lib/db/repos/productsRepo.js"));
  ({ createUser, addCredits, getUserById } = await import("@/lib/db/repos/usersRepo.js"));
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ listOrdersByUser } = await import("@/lib/db/repos/ordersRepo.js"));
}

async function seedUser(credits) {
  const u = await createUser("buyer@test.dev", "x", "Buyer");
  if (credits > 0) await addCredits(u.id, credits, null, { type: "admin_topup", idempotencyKey: `seed:${u.id}` });
  return u.id;
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-checkout-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules(); // reset driver.js module-level `const state` binding
  await loadModules();
  await getAdapter(); // force init + migrate
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("storeCheckout — happy path", () => {
  it("debits credits, creates a paid order, and fulfills instant delivery", async () => {
    const userId = await seedUser(1000);
    const product = await createProduct({
      kind: "service", name: "API Boost", priceCredits: 250,
      deliveryMode: "instant", stock: 5,
    });

    const res = await storeCheckout(userId, product.id, { quantity: 2, idempotencyKey: "buy-1" });

    expect(res.alreadyProcessed).toBe(false);
    expect(res.order.status).toBe("fulfilled"); // instant
    expect(res.order.totalCredits).toBe(500);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].quantity).toBe(2);

    const user = await getUserById(userId);
    expect(user.creditsBalance).toBe(500); // 1000 - 500

    const adapter = await getAdapter();
    const prod = adapter.get(`SELECT stock FROM products WHERE id = ?`, [product.id]);
    expect(prod.stock).toBe(3); // 5 - 2
  });

  it("leaves admin_fulfill orders in paid status", async () => {
    const userId = await seedUser(1000);
    const product = await createProduct({
      kind: "account", name: "Manual Acct", priceCredits: 100,
      deliveryMode: "admin_fulfill", stock: null,
    });
    const res = await storeCheckout(userId, product.id, { idempotencyKey: "buy-2" });
    expect(res.order.status).toBe("paid");
  });
});

describe("storeCheckout — guards", () => {
  it("rejects when stock is insufficient (oversell-safe)", async () => {
    const userId = await seedUser(1000);
    const product = await createProduct({
      kind: "service", name: "Scarce", priceCredits: 10,
      deliveryMode: "instant", stock: 1,
    });
    await expect(
      storeCheckout(userId, product.id, { quantity: 2, idempotencyKey: "os-1" })
    ).rejects.toMatchObject({ code: "OUT_OF_STOCK" });

    // No partial debit
    const user = await getUserById(userId);
    expect(user.creditsBalance).toBe(1000);
  });

  it("rejects when the balance is too low and does not decrement stock", async () => {
    const userId = await seedUser(50);
    const product = await createProduct({
      kind: "service", name: "Pricey", priceCredits: 100,
      deliveryMode: "instant", stock: 3,
    });
    await expect(
      storeCheckout(userId, product.id, { idempotencyKey: "ic-1" })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });

    const adapter = await getAdapter();
    const prod = adapter.get(`SELECT stock FROM products WHERE id = ?`, [product.id]);
    expect(prod.stock).toBe(3); // rolled back
  });

  it("rejects a missing product", async () => {
    const userId = await seedUser(1000);
    await expect(
      storeCheckout(userId, "nope", { idempotencyKey: "m-1" })
    ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });

  it("rejects an inactive product", async () => {
    const userId = await seedUser(1000);
    const product = await createProduct({
      kind: "service", name: "Retired", priceCredits: 10,
      deliveryMode: "instant", isActive: false,
    });
    await expect(
      storeCheckout(userId, product.id, { idempotencyKey: "ia-1" })
    ).rejects.toMatchObject({ code: "INACTIVE" });
  });

  it("rejects an invalid quantity", async () => {
    const userId = await seedUser(1000);
    const product = await createProduct({
      kind: "service", name: "X", priceCredits: 10, deliveryMode: "instant",
    });
    await expect(
      storeCheckout(userId, product.id, { quantity: 0 })
    ).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
  });
});

describe("storeCheckout — idempotency", () => {
  it("returns the existing order on replay without double-charging", async () => {
    const userId = await seedUser(1000);
    const product = await createProduct({
      kind: "service", name: "Once", priceCredits: 200,
      deliveryMode: "instant", stock: 10,
    });

    const first = await storeCheckout(userId, product.id, { idempotencyKey: "dup-key" });
    const second = await storeCheckout(userId, product.id, { idempotencyKey: "dup-key" });

    expect(first.alreadyProcessed).toBe(false);
    expect(second.alreadyProcessed).toBe(true);
    expect(second.order.id).toBe(first.order.id);

    const user = await getUserById(userId);
    expect(user.creditsBalance).toBe(800); // charged once

    const orders = await listOrdersByUser(userId);
    expect(orders).toHaveLength(1);
  });
});
