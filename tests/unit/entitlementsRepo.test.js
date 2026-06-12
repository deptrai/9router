// Story 2.29a — entitlementsRepo CRUD + lifecycle (AC4).
// Verifies create/list/get/transition + state-machine guards.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalEncKey = process.env.STORE_ENC_KEY;
const TEST_ENC_KEY = "0".repeat(64);

let entitlementsRepo, getAdapter, createUser;

async function loadModules() {
  entitlementsRepo = await import("@/lib/db/repos/entitlementsRepo.js");
  ({ getAdapter } = await import("@/lib/db/driver.js"));
  ({ createUser } = await import("@/lib/db/repos/usersRepo.js"));
}

async function seedUser(suffix = "u1") {
  const u = await createUser(`user-${suffix}@test.dev`, "x", `User ${suffix}`);
  return u.id;
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-entitlements-"));
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

describe("entitlementsRepo — schema constants & state machine", () => {
  it("exports the canonical statuses + route policies", () => {
    expect(entitlementsRepo.ENTITLEMENT_STATUSES).toEqual([
      "pending_connection",
      "active",
      "expired",
      "revoked",
    ]);
    expect(entitlementsRepo.ROUTE_POLICIES).toEqual([
      "prefer_owned",
      "owned_only",
    ]);
  });

  it("allows the documented transitions and same-state no-ops", () => {
    const { canTransitionEntitlement } = entitlementsRepo;
    // pending_connection branch
    expect(canTransitionEntitlement("pending_connection", "active")).toBe(true);
    expect(canTransitionEntitlement("pending_connection", "revoked")).toBe(true);
    // active branch
    expect(canTransitionEntitlement("active", "expired")).toBe(true);
    expect(canTransitionEntitlement("active", "revoked")).toBe(true);
    // expired can re-link
    expect(canTransitionEntitlement("expired", "active")).toBe(true);
    expect(canTransitionEntitlement("expired", "revoked")).toBe(true);
    // same state always allowed (no-op)
    expect(canTransitionEntitlement("active", "active")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    const { canTransitionEntitlement } = entitlementsRepo;
    // revoked is a sink
    expect(canTransitionEntitlement("revoked", "active")).toBe(false);
    expect(canTransitionEntitlement("revoked", "pending_connection")).toBe(false);
    // can't skip back to pending
    expect(canTransitionEntitlement("active", "pending_connection")).toBe(false);
    // can't bypass pending → expired directly
    expect(canTransitionEntitlement("pending_connection", "expired")).toBe(false);
  });
});

describe("entitlementsRepo — createEntitlement", () => {
  it("inserts a row with defaults (status=pending_connection, routePolicy=prefer_owned)", async () => {
    const userId = await seedUser();
    const ent = await entitlementsRepo.createEntitlement({
      userId,
      productId: "p1",
      provider: "anthropic",
    });
    expect(ent.id).toBeTruthy();
    expect(ent.userId).toBe(userId);
    expect(ent.productId).toBe("p1");
    expect(ent.provider).toBe("anthropic");
    expect(ent.status).toBe("pending_connection");
    expect(ent.routePolicy).toBe("prefer_owned");
    expect(ent.providerConnectionId).toBeNull();
    expect(ent.expiresAt).toBeNull();

    const fetched = await entitlementsRepo.getEntitlementById(ent.id);
    expect(fetched).toMatchObject({
      id: ent.id,
      userId,
      status: "pending_connection",
    });
  });

  it("preserves provider=null fail-safe (QĐ3) — product without targetId still creates entitlement", async () => {
    const userId = await seedUser();
    const ent = await entitlementsRepo.createEntitlement({
      userId,
      productId: "p-no-target",
      provider: null,
      note: "missing targetId — admin to fix",
    });
    expect(ent.provider).toBeNull();
    expect(ent.note).toMatch(/missing targetId/);
    expect(ent.status).toBe("pending_connection"); // still created — never block checkout
  });

  it("rejects missing userId / productId / invalid status / invalid routePolicy", async () => {
    await expect(
      entitlementsRepo.createEntitlement({ productId: "p1" })
    ).rejects.toThrow(/userId required/);

    await expect(
      entitlementsRepo.createEntitlement({ userId: "u1" })
    ).rejects.toThrow(/productId required/);

    await expect(
      entitlementsRepo.createEntitlement({
        userId: "u1",
        productId: "p1",
        status: "bogus",
      })
    ).rejects.toThrow(/invalid status/);

    await expect(
      entitlementsRepo.createEntitlement({
        userId: "u1",
        productId: "p1",
        routePolicy: "bogus",
      })
    ).rejects.toThrow(/invalid routePolicy/);
  });
});

describe("entitlementsRepo — listEntitlementsByUser / findPendingEntitlement", () => {
  it("returns entitlements newest-first and filters by status", async () => {
    const userId = await seedUser("listing");
    const e1 = await entitlementsRepo.createEntitlement({
      userId, productId: "p1", provider: "anthropic",
    });
    // ensure distinct createdAt — sleep 5ms (string ISO sort)
    await new Promise((r) => setTimeout(r, 5));
    const e2 = await entitlementsRepo.createEntitlement({
      userId, productId: "p2", provider: "openai",
    });

    const all = await entitlementsRepo.listEntitlementsByUser(userId);
    expect(all.map((e) => e.id)).toEqual([e2.id, e1.id]);

    // mark e1 active so we can filter
    await entitlementsRepo.transitionEntitlement(e1.id, "active");
    const onlyPending = await entitlementsRepo.listEntitlementsByUser(userId, {
      status: "pending_connection",
    });
    expect(onlyPending.map((e) => e.id)).toEqual([e2.id]);

    const multi = await entitlementsRepo.listEntitlementsByUser(userId, {
      status: ["pending_connection", "active"],
    });
    expect(multi).toHaveLength(2);
  });

  it("findPendingEntitlement returns oldest pending for the (user, provider) tuple", async () => {
    const userId = await seedUser("pending");
    const first = await entitlementsRepo.createEntitlement({
      userId, productId: "p1", provider: "anthropic",
    });
    await new Promise((r) => setTimeout(r, 5));
    await entitlementsRepo.createEntitlement({
      userId, productId: "p2", provider: "anthropic",
    });
    // unrelated provider — must NOT match
    await entitlementsRepo.createEntitlement({
      userId, productId: "p3", provider: "openai",
    });

    const pending = await entitlementsRepo.findPendingEntitlement(userId, "anthropic");
    expect(pending.id).toBe(first.id); // oldest

    // once activated, falls through to the next
    await entitlementsRepo.transitionEntitlement(first.id, "active");
    const next = await entitlementsRepo.findPendingEntitlement(userId, "anthropic");
    expect(next.productId).toBe("p2");

    // returns null when no pending exists for that provider
    const none = await entitlementsRepo.findPendingEntitlement(userId, "google");
    expect(none).toBeNull();
  });

  it("getEntitlementsByProduct lists all entitlements for a product", async () => {
    const userA = await seedUser("a");
    const userB = await seedUser("b");
    await entitlementsRepo.createEntitlement({
      userId: userA, productId: "shared-product", provider: "anthropic",
    });
    await new Promise((r) => setTimeout(r, 5));
    await entitlementsRepo.createEntitlement({
      userId: userB, productId: "shared-product", provider: "anthropic",
    });
    await entitlementsRepo.createEntitlement({
      userId: userA, productId: "other-product", provider: "openai",
    });

    const list = await entitlementsRepo.getEntitlementsByProduct("shared-product");
    expect(list).toHaveLength(2);
    // newest first; userB created last
    expect(list[0].userId).toBe(userB);
  });
});

describe("entitlementsRepo — transitionEntitlement state machine", () => {
  it("activates, then expires, then revokes — and reflects transitions in DB", async () => {
    const userId = await seedUser("life");
    const ent = await entitlementsRepo.createEntitlement({
      userId, productId: "p1", provider: "anthropic",
    });

    const a = await entitlementsRepo.transitionEntitlement(ent.id, "active", {
      providerConnectionId: "conn-1",
    });
    expect(a.status).toBe("active");
    expect(a.providerConnectionId).toBe("conn-1");

    const e = await entitlementsRepo.transitionEntitlement(ent.id, "expired");
    expect(e.status).toBe("expired");

    const r = await entitlementsRepo.transitionEntitlement(ent.id, "revoked", {
      note: "manual revoke",
    });
    expect(r.status).toBe("revoked");
    expect(r.note).toBe("manual revoke");
  });

  it("rejects illegal transitions (revoked → active, active → pending_connection)", async () => {
    const userId = await seedUser("illegal");
    const ent = await entitlementsRepo.createEntitlement({
      userId, productId: "p1", provider: "anthropic",
    });
    await entitlementsRepo.transitionEntitlement(ent.id, "active");

    await expect(
      entitlementsRepo.transitionEntitlement(ent.id, "pending_connection")
    ).rejects.toThrow(/illegal transition/);

    await entitlementsRepo.transitionEntitlement(ent.id, "revoked");
    // sink — revoked rejects everything
    await expect(
      entitlementsRepo.transitionEntitlement(ent.id, "active")
    ).rejects.toThrow(/illegal transition/);
  });

  it("throws on unknown entitlement id and unknown status", async () => {
    await expect(
      entitlementsRepo.transitionEntitlement("does-not-exist", "active")
    ).rejects.toThrow(/not found/);

    const userId = await seedUser("bad-status");
    const ent = await entitlementsRepo.createEntitlement({
      userId, productId: "p1", provider: "anthropic",
    });
    await expect(
      entitlementsRepo.transitionEntitlement(ent.id, "bogus")
    ).rejects.toThrow(/invalid status/);
  });
});

describe("entitlementsRepo — createEntitlementSync (in-transaction)", () => {
  it("inserts inside a caller-provided transaction (used by storeCheckout)", async () => {
    const userId = await seedUser("sync");
    const adapter = await getAdapter();
    let id;
    adapter.transaction(() => {
      const ent = entitlementsRepo.createEntitlementSync(adapter, {
        userId, productId: "p1", provider: "anthropic", now: "2026-06-12T00:00:00.000Z",
      });
      id = ent.id;
      // visible inside the same txn
      const peek = adapter.get(`SELECT * FROM entitlements WHERE id = ?`, [id]);
      expect(peek).toBeTruthy();
    });
    const persisted = await entitlementsRepo.getEntitlementById(id);
    expect(persisted.status).toBe("pending_connection");
    expect(persisted.createdAt).toBe("2026-06-12T00:00:00.000Z");
  });

  it("rolls back when the surrounding transaction throws (atomic guard)", async () => {
    const userId = await seedUser("rollback");
    const adapter = await getAdapter();
    let preCount;
    {
      const before = adapter.all(`SELECT COUNT(*) AS c FROM entitlements`);
      preCount = before[0].c;
    }
    expect(() =>
      adapter.transaction(() => {
        entitlementsRepo.createEntitlementSync(adapter, {
          userId, productId: "p1", provider: "anthropic",
        });
        throw new Error("boom");
      })
    ).toThrow(/boom/);
    const after = adapter.all(`SELECT COUNT(*) AS c FROM entitlements`);
    expect(after[0].c).toBe(preCount); // rolled back
  });
});
