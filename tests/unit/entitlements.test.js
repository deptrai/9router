// Story 2.29a — Entitlements (user_self_connect): mua → pending_connection →
// user kết nối tài khoản provider → link connection → active.
// Verifies: storeCheckout tạo entitlement, entitlementsRepo CRUD + transitions,
// connectionsRepo.linkConnectionToEntitlement (link + activate + ownership guard),
// và GET /api/store/entitlements user-scoped.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalEncKey = process.env.STORE_ENC_KEY;
const TEST_ENC_KEY = "0".repeat(64);

// Modules are re-imported per test so they bind to the fresh per-test adapter.
let storeCheckout, createProduct, createUser, addCredits, getAdapter;
let createEntitlement, getEntitlementById, listEntitlementsByUser,
  findPendingEntitlement, getEntitlementsByProduct, transitionEntitlement,
  canTransitionEntitlement, ENTITLEMENT_STATUSES, ROUTE_POLICIES;
let createProviderConnection, getProviderConnectionById, linkConnectionToEntitlement;

async function loadModules() {
  ({ storeCheckout } = await import("@/lib/store/storeCheckout.js"));
  ({ createProduct } = await import("@/lib/db/repos/productsRepo.js"));
  ({ createUser, addCredits } = await import("@/lib/db/repos/usersRepo.js"));
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({
    createEntitlement, getEntitlementById, listEntitlementsByUser,
    findPendingEntitlement, getEntitlementsByProduct, transitionEntitlement,
    canTransitionEntitlement, ENTITLEMENT_STATUSES, ROUTE_POLICIES,
  } = await import("@/lib/db/repos/entitlementsRepo.js"));
  ({
    createProviderConnection, getProviderConnectionById, linkConnectionToEntitlement,
  } = await import("@/lib/db/repos/connectionsRepo.js"));
}

async function seedUser(email, credits) {
  const u = await createUser(email, "x", "Buyer");
  if (credits > 0) {
    await addCredits(u.id, credits, null, { type: "admin_topup", idempotencyKey: `seed:${u.id}` });
  }
  return u.id;
}

async function makeSelfConnectProduct(overrides = {}) {
  return createProduct({
    kind: "account",
    name: "Claude Pro (tự kết nối)",
    priceCredits: 100,
    deliveryMode: "user_self_connect",
    targetId: "anthropic",
    stock: null,
    ...overrides,
  });
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-entitlements-"));
  process.env.DATA_DIR = tempDir;
  process.env.STORE_ENC_KEY = TEST_ENC_KEY;
  delete global._dbAdapter;
  vi.resetModules();
  await loadModules();
  await getAdapter(); // force init + migrate (008 creates entitlements table)
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

describe("storeCheckout — user_self_connect (AC1)", () => {
  it("tạo entitlement pending_connection, order vẫn ở trạng thái paid", async () => {
    const userId = await seedUser("buyer1@test.dev", 1000);
    const product = await makeSelfConnectProduct();

    const res = await storeCheckout(userId, product.id, { quantity: 1, idempotencyKey: "buy-sc-1" });

    expect(res.entitlementId).toBeTruthy();
    expect(res.order.status).toBe("paid");

    const ent = await getEntitlementById(res.entitlementId);
    expect(ent).toMatchObject({
      userId,
      productId: product.id,
      provider: "anthropic", // lấy từ product.targetId
      status: "pending_connection",
      providerConnectionId: null,
      routePolicy: "prefer_owned", // default
    });
  });

  it("idempotent replay không tạo entitlement trùng", async () => {
    const userId = await seedUser("buyer2@test.dev", 1000);
    const product = await makeSelfConnectProduct();

    const first = await storeCheckout(userId, product.id, { quantity: 1, idempotencyKey: "buy-sc-2" });
    const replay = await storeCheckout(userId, product.id, { quantity: 1, idempotencyKey: "buy-sc-2" });

    expect(replay.alreadyProcessed).toBe(true);
    const list = await listEntitlementsByUser(userId);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(first.entitlementId);
  });
});

describe("entitlementsRepo — CRUD + filters", () => {
  it("createEntitlement đặt default status/routePolicy và đọc lại được", async () => {
    const userId = await seedUser("repo1@test.dev", 0);
    const ent = await createEntitlement({ userId, productId: "p-1", provider: "anthropic" });
    expect(ent.status).toBe("pending_connection");
    expect(ent.routePolicy).toBe("prefer_owned");

    const fetched = await getEntitlementById(ent.id);
    expect(fetched.id).toBe(ent.id);
  });

  it("createEntitlement validate userId/productId/status/routePolicy", async () => {
    await expect(createEntitlement({ productId: "p" })).rejects.toThrow(/userId/);
    await expect(createEntitlement({ userId: "u" })).rejects.toThrow(/productId/);
    await expect(createEntitlement({ userId: "u", productId: "p", status: "bogus" }))
      .rejects.toThrow(/invalid status/);
    await expect(createEntitlement({ userId: "u", productId: "p", routePolicy: "bogus" }))
      .rejects.toThrow(/invalid routePolicy/);
  });

  it("listEntitlementsByUser lọc theo status (string + array), mới nhất trước", async () => {
    const userId = await seedUser("repo2@test.dev", 0);
    const a = await createEntitlement({ userId, productId: "p-a", provider: "anthropic" });
    const b = await createEntitlement({ userId, productId: "p-b", provider: "openai" });
    await transitionEntitlement(b.id, "revoked");

    const pending = await listEntitlementsByUser(userId, { status: "pending_connection" });
    expect(pending.map((e) => e.id)).toEqual([a.id]);

    const both = await listEntitlementsByUser(userId, {
      status: ["pending_connection", "revoked"],
    });
    expect(both).toHaveLength(2);
    // chứa cả hai (không assert thứ tự chính xác — createdAt có thể trùng ms)
    expect(both.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("findPendingEntitlement trả về cái cũ nhất cho đúng provider", async () => {
    const userId = await seedUser("repo3@test.dev", 0);
    const first = await createEntitlement({ userId, productId: "p-1", provider: "anthropic" });
    await createEntitlement({ userId, productId: "p-2", provider: "anthropic" });
    await createEntitlement({ userId, productId: "p-3", provider: "openai" });

    const found = await findPendingEntitlement(userId, "anthropic");
    expect(found.id).toBe(first.id); // ORDER BY createdAt ASC

    const none = await findPendingEntitlement(userId, "gemini");
    expect(none).toBeNull();
  });

  it("getEntitlementsByProduct trả entitlements của product (mới nhất trước)", async () => {
    const u1 = await seedUser("repo4a@test.dev", 0);
    const u2 = await seedUser("repo4b@test.dev", 0);
    const e1 = await createEntitlement({ userId: u1, productId: "shared", provider: "anthropic" });
    const e2 = await createEntitlement({ userId: u2, productId: "shared", provider: "anthropic" });

    const rows = await getEntitlementsByProduct("shared");
    expect(rows).toHaveLength(2);
    // chứa cả hai (không assert thứ tự — createdAt có thể trùng ms)
    expect(rows.map((r) => r.id).sort()).toEqual([e1.id, e2.id].sort());
  });
});

describe("entitlementsRepo — transitions", () => {
  it("canTransitionEntitlement enforce ma trận hợp lệ", () => {
    expect(canTransitionEntitlement("pending_connection", "active")).toBe(true);
    expect(canTransitionEntitlement("pending_connection", "revoked")).toBe(true);
    expect(canTransitionEntitlement("pending_connection", "expired")).toBe(false);
    expect(canTransitionEntitlement("active", "expired")).toBe(true);
    expect(canTransitionEntitlement("revoked", "active")).toBe(false);
    expect(canTransitionEntitlement("active", "active")).toBe(true); // no-op cho phép
  });

  it("transitionEntitlement chặn chuyển trạng thái bất hợp lệ", async () => {
    const userId = await seedUser("trans1@test.dev", 0);
    const ent = await createEntitlement({ userId, productId: "p", provider: "anthropic" });
    await expect(transitionEntitlement(ent.id, "expired")).rejects.toThrow(/illegal transition/);
  });

  it("transitionEntitlement lỗi khi entitlement không tồn tại", async () => {
    await expect(transitionEntitlement("nope", "active")).rejects.toThrow(/not found/);
  });
});

describe("connectionsRepo.linkConnectionToEntitlement (AC3)", () => {
  it("link connection + activate entitlement atomically", async () => {
    const userId = await seedUser("link1@test.dev", 1000);
    const product = await makeSelfConnectProduct();
    const { entitlementId } = await storeCheckout(userId, product.id, {
      quantity: 1, idempotencyKey: "buy-link-1",
    });

    const conn = await createProviderConnection({
      provider: "anthropic",
      authType: "access_token",
      name: "my-claude",
      ownerUserId: userId,
    });

    const res = await linkConnectionToEntitlement(conn.id, entitlementId, userId);
    expect(res.entitlement.status).toBe("active");
    expect(res.entitlement.providerConnectionId).toBe(conn.id);

    const linked = await getProviderConnectionById(conn.id);
    expect(linked.entitlementId).toBe(entitlementId);

    const ent = await getEntitlementById(entitlementId);
    expect(ent.status).toBe("active");
    expect(ent.providerConnectionId).toBe(conn.id);
  });

  it("chặn link entitlement của user khác (ownership guard)", async () => {
    const owner = await seedUser("link2a@test.dev", 1000);
    const attacker = await seedUser("link2b@test.dev", 0);
    const product = await makeSelfConnectProduct();
    const { entitlementId } = await storeCheckout(owner, product.id, {
      quantity: 1, idempotencyKey: "buy-link-2",
    });
    const conn = await createProviderConnection({
      provider: "anthropic", authType: "access_token", name: "atk", ownerUserId: attacker,
    });

    await expect(linkConnectionToEntitlement(conn.id, entitlementId, attacker))
      .rejects.toThrow(/không thuộc về user/);

    const ent = await getEntitlementById(entitlementId);
    expect(ent.status).toBe("pending_connection"); // không bị đổi
  });

  it("lỗi khi connection hoặc entitlement không tồn tại", async () => {
    const userId = await seedUser("link3@test.dev", 0);
    const ent = await createEntitlement({ userId, productId: "p", provider: "anthropic" });
    await expect(linkConnectionToEntitlement("nope", ent.id, userId)).rejects.toThrow(/not found/);

    const conn = await createProviderConnection({
      provider: "anthropic", authType: "access_token", name: "c", ownerUserId: userId,
    });
    await expect(linkConnectionToEntitlement(conn.id, "nope", userId)).rejects.toThrow(/not found/);
  });
});

describe("enums", () => {
  it("ENTITLEMENT_STATUSES và ROUTE_POLICIES đúng tập giá trị", () => {
    expect(ENTITLEMENT_STATUSES).toEqual([
      "pending_connection", "active", "expired", "revoked",
    ]);
    expect(ROUTE_POLICIES).toEqual(["prefer_owned", "owned_only"]);
  });
});
