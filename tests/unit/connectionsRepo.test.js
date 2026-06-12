// Story 2.29a — connectionsRepo: linkConnectionToEntitlement + ownerUserId regression (AC2, AC6).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalEncKey = process.env.STORE_ENC_KEY;
const TEST_ENC_KEY = "0".repeat(64);

let connectionsRepo, entitlementsRepo, getAdapter, createUser;

async function loadModules() {
  connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  entitlementsRepo = await import("@/lib/db/repos/entitlementsRepo.js");
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ createUser } = await import("@/lib/db/repos/usersRepo.js"));
}

async function seedUser(suffix = "u1") {
  const u = await createUser(`conn-${suffix}@test.dev`, "x", `Conn User ${suffix}`);
  return u.id;
}

async function seedConnection(provider = "anthropic", name = "Admin Pool Acc") {
  return connectionsRepo.createProviderConnection({
    provider,
    authType: "api_key",
    name,
    data: { accessToken: "sk-fake-" + Math.random().toString(36).slice(2) },
  });
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-connRepo-"));
  process.env.DATA_DIR = tempDir;
  process.env.STORE_ENC_KEY = TEST_ENC_KEY;
  delete global._dbAdapter;
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

describe("connectionsRepo — linkConnectionToEntitlement (AC2)", () => {
  it("sets ownerUserId + entitlementId on connection AND activates entitlement", async () => {
    const userId = await seedUser("link");
    const conn = await seedConnection("anthropic", "User Acc");
    const ent = await entitlementsRepo.createEntitlement({
      userId, productId: "p1", provider: "anthropic",
    });

    const result = await connectionsRepo.linkConnectionToEntitlement(
      conn.id, ent.id, userId
    );

    // Connection updated
    expect(result.connection.ownerUserId).toBe(userId);
    expect(result.connection.entitlementId).toBe(ent.id);
    // Entitlement activated
    expect(result.entitlement.status).toBe("active");
    expect(result.entitlement.providerConnectionId).toBe(conn.id);
  });

  it("rejects when entitlement does not belong to the user (ownership guard)", async () => {
    const userA = await seedUser("ownerA");
    const userB = await seedUser("ownerB");
    const conn = await seedConnection("anthropic");
    const ent = await entitlementsRepo.createEntitlement({
      userId: userA, productId: "p1", provider: "anthropic",
    });

    // userB tries to link userA's entitlement
    await expect(
      connectionsRepo.linkConnectionToEntitlement(conn.id, ent.id, userB)
    ).rejects.toThrow(/không thuộc về user/);
  });

  it("rejects when entitlement is already revoked (status guard)", async () => {
    const userId = await seedUser("revoked");
    const conn = await seedConnection("anthropic");
    const ent = await entitlementsRepo.createEntitlement({
      userId, productId: "p1", provider: "anthropic",
    });
    // Revoke it
    await entitlementsRepo.transitionEntitlement(ent.id, "revoked");

    await expect(
      connectionsRepo.linkConnectionToEntitlement(conn.id, ent.id, userId)
    ).rejects.toThrow(/illegal transition/);
  });

  it("rejects when connection does not exist", async () => {
    const userId = await seedUser("noconn");
    const ent = await entitlementsRepo.createEntitlement({
      userId, productId: "p1", provider: "anthropic",
    });

    await expect(
      connectionsRepo.linkConnectionToEntitlement("fake-conn-id", ent.id, userId)
    ).rejects.toThrow(/connection.*not found/);
  });

  it("rejects when entitlement does not exist", async () => {
    const userId = await seedUser("noent");
    const conn = await seedConnection("anthropic");

    await expect(
      connectionsRepo.linkConnectionToEntitlement(conn.id, "fake-ent-id", userId)
    ).rejects.toThrow(/entitlement.*not found/);
  });
  it("rejects when connection is already owned by a different user (hijack guard)", async () => {
    const userA = await seedUser("hj-a");
    const userB = await seedUser("hj-b");
    const conn = await seedConnection("anthropic", "Owned by A");
    const entA = await entitlementsRepo.createEntitlement({
      userId: userA, productId: "p1", provider: "anthropic",
    });
    // userA claims the connection
    await connectionsRepo.linkConnectionToEntitlement(conn.id, entA.id, userA);

    // userB tries to claim the SAME connection for their own entitlement
    const entB = await entitlementsRepo.createEntitlement({
      userId: userB, productId: "p2", provider: "anthropic",
    });
    await expect(
      connectionsRepo.linkConnectionToEntitlement(conn.id, entB.id, userB)
    ).rejects.toThrow(/đã thuộc về user khác/);
  });

  it("allows the owner to re-link their own connection (ownerUserId === userId)", async () => {
    const userId = await seedUser("relink");
    const conn = await seedConnection("anthropic", "Mine");
    const ent1 = await entitlementsRepo.createEntitlement({
      userId, productId: "p1", provider: "anthropic",
    });
    await connectionsRepo.linkConnectionToEntitlement(conn.id, ent1.id, userId);
    // expire ent1 so the connection can be re-linked to a fresh entitlement
    await entitlementsRepo.transitionEntitlement(ent1.id, "expired");

    const ent2 = await entitlementsRepo.createEntitlement({
      userId, productId: "p2", provider: "anthropic",
    });
    const result = await connectionsRepo.linkConnectionToEntitlement(conn.id, ent2.id, userId);
    expect(result.entitlement.status).toBe("active");
    expect(result.connection.ownerUserId).toBe(userId);
  });
});

describe("connectionsRepo — ownerUserId=null regression (AC6/M1)", () => {
  it("admin-created connections have ownerUserId=null in DB (M1 backward-compat)", async () => {
    const conn = await seedConnection("anthropic", "Shared Admin");
    // Read back from DB (same path routing uses) to verify NULL persisted
    const all = await connectionsRepo.getProviderConnections({
      provider: "anthropic", isActive: true,
    });
    const fromDb = all.find((c) => c.id === conn.id);
    expect(fromDb).toBeTruthy();
    expect(fromDb.ownerUserId).toBeNull();
    expect(fromDb.entitlementId).toBeNull();
  });

  it("getProviderConnections still returns ownerUserId=null connections (shared pool intact)", async () => {
    // Create 2 shared + 1 owned
    const shared1 = await seedConnection("anthropic", "Shared 1");
    const shared2 = await seedConnection("anthropic", "Shared 2");
    const userId = await seedUser("owned");
    const owned = await seedConnection("anthropic", "Owned");
    const ent = await entitlementsRepo.createEntitlement({
      userId, productId: "p1", provider: "anthropic",
    });
    await connectionsRepo.linkConnectionToEntitlement(owned.id, ent.id, userId);

    // getProviderConnections returns ALL active connections for the provider
    // (routing filter is 2.29b's job — 2.29a must NOT break this)
    const all = await connectionsRepo.getProviderConnections({
      provider: "anthropic",
      isActive: true,
    });
    expect(all.length).toBe(3);
    const ids = all.map((c) => c.id);
    expect(ids).toContain(shared1.id);
    expect(ids).toContain(shared2.id);
    expect(ids).toContain(owned.id);

    // Shared connections still have null ownerUserId
    const sharedConns = all.filter((c) => c.ownerUserId === null);
    expect(sharedConns).toHaveLength(2);
  });
});
