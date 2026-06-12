// Story 2.26 — storeCheckout atomic purchase (credit-paid Telegram Store)
// Verifies: happy path debit+order, oversell guard, insufficient credits,
// idempotent replay, inactive/missing product, instant fulfillment.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalEncKey = process.env.STORE_ENC_KEY;
const TEST_ENC_KEY = "0".repeat(64);

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
  process.env.STORE_ENC_KEY = TEST_ENC_KEY;
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
  if (originalEncKey === undefined) delete process.env.STORE_ENC_KEY;
  else process.env.STORE_ENC_KEY = originalEncKey;
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

describe("storeCheckout — credential product fulfillment (Story 2.27)", () => {
  it("delivers a credential from inventory on instant purchase", async () => {
    const { addCredential } = await import("@/lib/db/repos/credentialsRepo.js");
    const userId = await seedUser(500);
    const product = await createProduct({
      kind: "credential", name: "VPN Key", priceCredits: 100,
      deliveryMode: "instant",
    });
    const cred = await addCredential(product.id, { username: "vpnuser", password: "pass123" });

    const res = await storeCheckout(userId, product.id, { idempotencyKey: "cred-1" });

    expect(res.order.status).toBe("fulfilled");
    expect(res.deliveredCredentialIds).toHaveLength(1);
    expect(res.deliveredCredentialIds[0]).toBe(cred.id);
  });

  it("throws NO_INVENTORY when credential inventory is exhausted (AC2)", async () => {
    const { addCredential } = await import("@/lib/db/repos/credentialsRepo.js");
    const userId = await seedUser(500);
    const product = await createProduct({
      kind: "credential", name: "Scarce Key", priceCredits: 100,
      deliveryMode: "instant",
    });
    await addCredential(product.id, { username: "only", password: "one" });

    // First purchase consumes the only available credential.
    await storeCheckout(userId, product.id, { idempotencyKey: "cred-exh-1" });

    // Second purchase: product has inventory but none available → NO_INVENTORY, no debit.
    await expect(
      storeCheckout(userId, product.id, { idempotencyKey: "cred-exh-2" })
    ).rejects.toMatchObject({ code: "NO_INVENTORY" });

    const user = await getUserById(userId);
    expect(user.creditsBalance).toBe(400); // charged once (first purchase only)
  });

  it("falls back to stock path when product has NO inventory record (D3/AC8)", async () => {
    // QĐ1/D3: inventory is source of truth only when ≥1 credential row exists.
    // A credential product with zero inventory rows uses products.stock (Story 2.26).
    const userId = await seedUser(500);
    const product = await createProduct({
      kind: "credential", name: "No Inventory Key", priceCredits: 100,
      deliveryMode: "instant", stock: null, // unlimited
    });

    const res = await storeCheckout(userId, product.id, { idempotencyKey: "cred-none" });

    // Does NOT throw NO_INVENTORY; fulfills via stock path, no credential delivered.
    expect(res.order.status).toBe("fulfilled");
    expect(res.deliveredCredentialIds).toBeNull();

    const user = await getUserById(userId);
    expect(user.creditsBalance).toBe(400); // charged normally
  });

  it("delivers multiple credentials for quantity > 1", async () => {
    const { addCredential, countAvailableCredentials } = await import("@/lib/db/repos/credentialsRepo.js");
    const userId = await seedUser(1000);
    const product = await createProduct({
      kind: "credential", name: "Batch Key", priceCredits: 100,
      deliveryMode: "instant",
    });
    await addCredential(product.id, { k: "key-1" });
    await addCredential(product.id, { k: "key-2" });
    await addCredential(product.id, { k: "key-3" });

    const res = await storeCheckout(userId, product.id, { quantity: 2, idempotencyKey: "cred-multi" });

    expect(res.order.status).toBe("fulfilled");
    expect(res.order.totalCredits).toBe(200);
    expect(res.deliveredCredentialIds).toHaveLength(2);
    expect(await countAvailableCredentials(product.id)).toBe(1);
  });

  it("NO_INVENTORY mid-batch rolls back — no partial delivery or debit", async () => {
    const { addCredential, countAvailableCredentials } = await import("@/lib/db/repos/credentialsRepo.js");
    const userId = await seedUser(1000);
    const product = await createProduct({
      kind: "credential", name: "Scarce Key", priceCredits: 100,
      deliveryMode: "instant",
    });
    await addCredential(product.id, { k: "only-one" });

    await expect(
      storeCheckout(userId, product.id, { quantity: 2, idempotencyKey: "cred-partial" })
    ).rejects.toMatchObject({ code: "NO_INVENTORY" });

    const user = await getUserById(userId);
    expect(user.creditsBalance).toBe(1000);
    expect(await countAvailableCredentials(product.id)).toBe(1);
  });

  it("non-credential instant products have deliveredCredentialIds: null", async () => {
    const userId = await seedUser(500);
    const product = await createProduct({
      kind: "service", name: "API Boost", priceCredits: 100,
      deliveryMode: "instant", stock: 5,
    });
    const res = await storeCheckout(userId, product.id, { idempotencyKey: "svc-cred-1" });
    expect(res.order.status).toBe("fulfilled");
    expect(res.deliveredCredentialIds).toBeNull();
  });
});

describe("storeCheckout — edge cases", () => {
  it("fulfills instantly when stock is unlimited (null)", async () => {
    const userId = await seedUser(500);
    const product = await createProduct({
      kind: "service", name: "Unlimited SVC", priceCredits: 50,
      deliveryMode: "instant", stock: null,
    });
    const res = await storeCheckout(userId, product.id, { idempotencyKey: "unl-1" });
    expect(res.order.status).toBe("fulfilled");
    const user = await getUserById(userId);
    expect(user.creditsBalance).toBe(450);
  });

  it("leaves user_self_connect orders in paid status and creates a pending entitlement (Story 2.29a/AC1)", async () => {
    const userId = await seedUser(300);
    const product = await createProduct({
      kind: "account", name: "Self Connect", priceCredits: 100,
      deliveryMode: "user_self_connect", stock: null,
      targetType: "provider", targetId: "anthropic",
    });
    const res = await storeCheckout(userId, product.id, { idempotencyKey: "usc-1" });
    expect(res.order.status).toBe("paid");
    expect(res.order.deliveryMode).toBe("user_self_connect");
    // AC1: checkout result returns entitlementId
    expect(res.entitlementId).toBeTruthy();

    // entitlement row created with the right shape
    const adapter = await getAdapter();
    const ent = adapter.get(`SELECT * FROM entitlements WHERE id = ?`, [res.entitlementId]);
    expect(ent).toBeTruthy();
    expect(ent.userId).toBe(userId);
    expect(ent.productId).toBe(product.id);
    expect(ent.provider).toBe("anthropic"); // QĐ3: derived from product.targetId
    expect(ent.status).toBe("pending_connection");
    expect(ent.routePolicy).toBe("prefer_owned"); // default
    expect(ent.providerConnectionId).toBeNull();
  });

  it("user_self_connect with no targetId still creates entitlement with provider=null (QĐ3 fail-safe)", async () => {
    const userId = await seedUser(300);
    const product = await createProduct({
      kind: "account", name: "Self Connect (no target)", priceCredits: 100,
      deliveryMode: "user_self_connect", stock: null,
      // No targetType/targetId — admin to fill later. Checkout must NOT block.
    });
    const res = await storeCheckout(userId, product.id, { idempotencyKey: "usc-no-target" });
    expect(res.order.status).toBe("paid");
    expect(res.entitlementId).toBeTruthy();

    const adapter = await getAdapter();
    const ent = adapter.get(`SELECT * FROM entitlements WHERE id = ?`, [res.entitlementId]);
    expect(ent.provider).toBeNull();
    expect(ent.status).toBe("pending_connection");
  });

  it("rejects quantity>1 for user_self_connect (per-user-per-provider, D1)", async () => {
    const userId = await seedUser(300);
    const product = await createProduct({
      kind: "account", name: "Self Connect Qty", priceCredits: 50,
      deliveryMode: "user_self_connect", stock: null,
      targetType: "provider", targetId: "anthropic",
    });
    await expect(
      storeCheckout(userId, product.id, { quantity: 2, idempotencyKey: "usc-qty" })
    ).rejects.toMatchObject({ code: "INVALID_QUANTITY" });

    // Credits must NOT be deducted on rejection
    const user = await getUserById(userId);
    expect(user.creditsBalance).toBe(300);
  });

  it("idempotent replay of user_self_connect does NOT duplicate entitlements", async () => {
    const userId = await seedUser(300);
    const product = await createProduct({
      kind: "account", name: "Self Connect Idem", priceCredits: 100,
      deliveryMode: "user_self_connect", stock: null,
      targetType: "provider", targetId: "anthropic",
    });
    const first = await storeCheckout(userId, product.id, { idempotencyKey: "usc-idem" });
    const second = await storeCheckout(userId, product.id, { idempotencyKey: "usc-idem" });
    expect(second.alreadyProcessed).toBe(true);
    expect(second.order.id).toBe(first.order.id);

    const adapter = await getAdapter();
    const rows = adapter.all(
      `SELECT id FROM entitlements WHERE userId = ? AND productId = ?`,
      [userId, product.id]
    );
    expect(rows).toHaveLength(1); // exactly one entitlement
    expect(rows[0].id).toBe(first.entitlementId);
  });

  it("succeeds when balance equals totalCredits exactly (boundary)", async () => {
    const userId = await seedUser(100);
    const product = await createProduct({
      kind: "service", name: "Exact Price", priceCredits: 100,
      deliveryMode: "instant", stock: null,
    });
    const res = await storeCheckout(userId, product.id, { idempotencyKey: "exact-1" });
    expect(res.order.status).toBe("fulfilled");
    const user = await getUserById(userId);
    expect(user.creditsBalance).toBe(0);
  });

  it("works without an idempotencyKey (no dedup key provided)", async () => {
    const userId = await seedUser(500);
    const product = await createProduct({
      kind: "service", name: "No Key SVC", priceCredits: 50,
      deliveryMode: "instant", stock: null,
    });
    const res = await storeCheckout(userId, product.id);
    expect(res.alreadyProcessed).toBe(false);
    expect(res.order.status).toBe("fulfilled");
    expect(res.order.idempotencyKey).toBeNull();
  });

  it("sets source=telegram and ledgerTxnId on the order", async () => {
    const userId = await seedUser(500);
    const product = await createProduct({
      kind: "service", name: "Ledger Check", priceCredits: 75,
      deliveryMode: "admin_fulfill", stock: null,
    });
    const res = await storeCheckout(userId, product.id, { idempotencyKey: "ledger-1" });
    expect(res.order.source).toBe("telegram");
    expect(res.order.ledgerTxnId).toBeTruthy();
    expect(res.ledgerTxnId).toBe(res.order.ledgerTxnId);
  });

  it("snapshots product name in orderItems so later renames do not affect it", async () => {
    const userId = await seedUser(500);
    const product = await createProduct({
      kind: "service", name: "Original Name", priceCredits: 50,
      deliveryMode: "instant", stock: null,
    });
    const res = await storeCheckout(userId, product.id, { idempotencyKey: "snap-1" });
    // Mutate product name in DB directly
    const adapter = await getAdapter();
    adapter.run(`UPDATE products SET name = 'Renamed' WHERE id = ?`, [product.id]);
    // The order item should still carry the original name
    expect(res.items[0].productName).toBe("Original Name");
  });
});
