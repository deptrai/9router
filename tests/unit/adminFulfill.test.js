// Story 2.28 — adminFulfill (manual fulfill + cancel) unit tests
// Verifies: fulfillOrder paid→fulfilled + fulfilledAt + credential reserve/deliver,
// cancelOrder paid→cancelled + reservation release, guards (ORDER_NOT_FOUND,
// INVALID_STATE, CREDENTIAL_UNAVAILABLE), Telegram best-effort delivery, NFR8.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock the Telegram client so we can assert delivery without a real bot token.
const sendMessageMock = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/telegram/botClient.js", () => ({
  sendMessage: (...args) => sendMessageMock(...args),
  answerCallbackQuery: vi.fn(async () => ({ ok: true })),
  isBotConfigured: () => true,
}));

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalEncKey = process.env.STORE_ENC_KEY;
const TEST_ENC_KEY = "0".repeat(64);

let fulfillOrder, cancelOrder, FulfillError,
    storeCheckout, createProduct, createUser, addCredits, updateUser,
    addCredential, listCredentials, getOrderWithItems, getAdapter;

async function loadModules() {
  ({ fulfillOrder, cancelOrder, FulfillError } = await import("@/lib/store/adminFulfill.js"));
  ({ storeCheckout } = await import("@/lib/store/storeCheckout.js"));
  ({ createProduct } = await import("@/lib/db/repos/productsRepo.js"));
  ({ createUser, addCredits, updateUser } = await import("@/lib/db/repos/usersRepo.js"));
  ({ addCredential, listCredentials } = await import("@/lib/db/repos/credentialsRepo.js"));
  ({ getOrderWithItems, getAdapter } = await import("@/lib/db/repos/ordersRepo.js"));
  ({ getAdapter } = await import("@/lib/db/driver.js"));
}

async function seedUser(credits, { telegramId = null } = {}) {
  const u = await createUser("buyer@test.dev", "x", "Buyer");
  if (credits > 0) await addCredits(u.id, credits, null, { type: "admin_topup", idempotencyKey: `seed:${u.id}` });
  if (telegramId) await updateUser(u.id, { telegramId });
  return u.id;
}

// Create a paid (unfulfilled) order via admin_fulfill checkout.
async function seedPaidOrder(userId, productOverrides = {}) {
  const product = await createProduct({
    kind: "account", name: "Manual Acct", priceCredits: 100,
    deliveryMode: "admin_fulfill", stock: null, ...productOverrides,
  });
  const res = await storeCheckout(userId, product.id, { idempotencyKey: `paid:${product.id}` });
  return { product, order: res.order };
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fulfill-"));
  process.env.DATA_DIR = tempDir;
  process.env.STORE_ENC_KEY = TEST_ENC_KEY;
  delete global._dbAdapter;
  sendMessageMock.mockClear();
  vi.resetModules();
  await loadModules();
  await getAdapter();
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

describe("fulfillOrder — happy path (AC3)", () => {
  it("transitions paid → fulfilled and stamps fulfilledAt", async () => {
    const userId = await seedUser(500, { telegramId: "tg-123" });
    const { order } = await seedPaidOrder(userId);
    expect(order.status).toBe("paid");

    const res = await fulfillOrder(order.id, { note: "Đã giao tay" });

    expect(res.order.status).toBe("fulfilled");
    expect(res.order.fulfilledAt).toBeTruthy();
    expect(res.credentialDelivered).toBe(false);
    expect(res.telegramSent).toBe(true); // notifyFulfilled to buyer's telegramId

    const reloaded = await getOrderWithItems(order.id);
    expect(reloaded.status).toBe("fulfilled");
    expect(reloaded.fulfilledAt).toBeTruthy();
  });

  it("reserves + delivers a specific credential and pushes payload via Telegram", async () => {
    const userId = await seedUser(500, { telegramId: "tg-777" });
    const { product, order } = await seedPaidOrder(userId, { kind: "credential" });
    const cred = await addCredential(product.id, { username: "u1", password: "p1" });

    const res = await fulfillOrder(order.id, { credentialId: cred.id });

    expect(res.order.status).toBe("fulfilled");
    expect(res.credentialDelivered).toBe(true);
    expect(res.telegramSent).toBe(true);

    // Credential is now delivered + linked to the order.
    const creds = await listCredentials(product.id, {});
    expect(creds[0].status).toBe("delivered");
    expect(creds[0].orderId).toBe(order.id);

    // The payload message went to the buyer's telegramId.
    const payloadCall = sendMessageMock.mock.calls.find((c) => String(c[1]).includes("Credential"));
    expect(payloadCall).toBeTruthy();
    expect(payloadCall[0]).toBe("tg-777");
  });

  it("succeeds without a buyer telegramId (telegramSent=false, no throw)", async () => {
    const userId = await seedUser(500); // no telegramId
    const { order } = await seedPaidOrder(userId);
    const res = await fulfillOrder(order.id);
    expect(res.order.status).toBe("fulfilled");
    expect(res.telegramSent).toBe(false);
  });
});

describe("fulfillOrder — guards", () => {
  it("throws ORDER_NOT_FOUND for a missing order", async () => {
    await expect(fulfillOrder("nope")).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("throws INVALID_STATE when the order is already fulfilled", async () => {
    const userId = await seedUser(500);
    const { order } = await seedPaidOrder(userId);
    await fulfillOrder(order.id);
    await expect(fulfillOrder(order.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("throws CREDENTIAL_UNAVAILABLE for an unknown/taken credential and leaves order paid", async () => {
    const userId = await seedUser(500);
    const { order } = await seedPaidOrder(userId, { kind: "credential" });

    await expect(
      fulfillOrder(order.id, { credentialId: "ghost-cred" })
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });

    // Transaction rolled back — order is still paid (not fulfilled).
    const reloaded = await getOrderWithItems(order.id);
    expect(reloaded.status).toBe("paid");
    expect(reloaded.fulfilledAt).toBeNull();
  });
});

describe("cancelOrder (AC4)", () => {
  it("transitions paid → cancelled with no refund", async () => {
    const userId = await seedUser(500);
    const { order } = await seedPaidOrder(userId);
    const res = await cancelOrder(order.id, { note: "Khách đổi ý" });
    expect(res.order.status).toBe("cancelled");
    expect(res.releasedCredentials).toBe(0);

    const reloaded = await getOrderWithItems(order.id);
    expect(reloaded.status).toBe("cancelled");
  });

  it("releases a reserved credential back to available on cancel", async () => {
    const userId = await seedUser(500);
    const { product, order } = await seedPaidOrder(userId, { kind: "credential" });
    const cred = await addCredential(product.id, { k: "v" });

    // Reserve the credential against the order (mid-fulfillment state) using the repo helper.
    const adapter = await getAdapter();
    const { reserveCredentialByIdSync } = await import("@/lib/db/repos/credentialsRepo.js");
    adapter.transaction(() => {
      reserveCredentialByIdSync(adapter, cred.id, order.id, order.items?.[0]?.id ?? null, new Date().toISOString());
    });
    let creds = await listCredentials(product.id, {});
    expect(creds[0].status).toBe("reserved");

    const res = await cancelOrder(order.id);
    expect(res.order.status).toBe("cancelled");
    expect(res.releasedCredentials).toBe(1);

    creds = await listCredentials(product.id, {});
    expect(creds[0].status).toBe("available");
    expect(creds[0].orderId).toBeNull();
    expect(creds[0].reservedAt).toBeNull();
  });

  it("throws INVALID_STATE when the order is not paid", async () => {
    const userId = await seedUser(500);
    const { order } = await seedPaidOrder(userId);
    await fulfillOrder(order.id);
    await expect(cancelOrder(order.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("throws ORDER_NOT_FOUND for a missing order", async () => {
    await expect(cancelOrder("nope")).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });
});
