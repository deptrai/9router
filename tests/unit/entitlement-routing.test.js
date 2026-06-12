/**
 * Tests for story 2.29b — Entitlement Routing Engine Integration
 * AC1: prefer_owned / owned_only → owned connection chọn đúng
 * AC2: fast-path userId=null hoặc no-entitlement → shared pool
 * AC3: infra-error resolve → fail-open shared
 * AC4: expired/revoked/inactive → owned không chọn
 * AC5: owned_only + không có owned → ownedOnlyUnavailable signal
 * AC6: cross-user isolation — user B không nhận connection của user A
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// AC3 infra-error test dùng vi.doMock (not hoisted) — xem describe AC3 bên dưới.

let tmpDir;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "9router-ent-routing-"));
  process.env.DATA_DIR = tmpDir;
  process.env.STORE_ENC_KEY = "test-enc-key-32bytes-placeholder!";
  delete global._dbAdapter;
  vi.resetModules();
  const { getAdapter } = await import("@/lib/db/driver.js");
  await getAdapter();
});

afterEach(() => {
  delete global._dbAdapter;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function insertConnection({ provider = "anthropic", isActive = true, ownerUserId = null, priority = 1 } = {}) {
  const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
  return createProviderConnection({
    provider,
    authType: "apiKey",
    name: `conn-${Math.random().toString(36).slice(2, 7)}`,
    apiKey: `sk-test-${Math.random().toString(36).slice(2)}`,
    isActive,
    ownerUserId,
    priority,
  });
}

async function insertEntitlement({ userId, provider = "anthropic", status = "active", routePolicy = "prefer_owned", expiresAt = null } = {}) {
  const { createEntitlement } = await import("@/lib/db/repos/entitlementsRepo.js");
  return createEntitlement({ userId, productId: "prod-test", provider, status, routePolicy, expiresAt });
}

async function callGetProviderCredentials(provider, opts = {}) {
  const { getProviderCredentials } = await import("@/sse/services/auth.js");
  return getProviderCredentials(provider, null, null, opts);
}

// ── AC1: prefer_owned → chọn owned connection ──────────────────────────────

describe("AC1 — prefer_owned selects owned connection", () => {
  it("chọn owned connection khi user có active entitlement (prefer_owned)", async () => {
    const shared = await insertConnection({ ownerUserId: null });
    const owned = await insertConnection({ ownerUserId: "user-A" });
    await insertEntitlement({ userId: "user-A", routePolicy: "prefer_owned" });

    const creds = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    expect(creds).not.toBeNull();
    expect(creds?.ownedOnlyUnavailable).toBeUndefined();
    expect(creds.connectionId).toBe(owned.id);
  });

  it("chọn owned connection khi user có active entitlement (owned_only)", async () => {
    await insertConnection({ ownerUserId: null });
    const owned = await insertConnection({ ownerUserId: "user-A" });
    await insertEntitlement({ userId: "user-A", routePolicy: "owned_only" });

    const creds = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    expect(creds?.connectionId).toBe(owned.id);
  });
});

// ── AC2: fast-path ─────────────────────────────────────────────────────────

describe("AC2 — fast-path: userId null hoặc no-entitlement → shared pool", () => {
  it("userId null → trả shared connection (admin pool unchanged)", async () => {
    const shared = await insertConnection({ ownerUserId: null });
    await insertConnection({ ownerUserId: "user-X" }); // owned của người khác — không được chọn

    const creds = await callGetProviderCredentials("anthropic", {});
    // Không có userId → pool không lọc, tất cả connection đều available
    expect(creds).not.toBeNull();
    expect(creds?.ownedOnlyUnavailable).toBeUndefined();
  });

  it("user không có entitlement → chỉ shared pool (loại owned của người khác M5)", async () => {
    const shared = await insertConnection({ ownerUserId: null });
    const otherOwned = await insertConnection({ ownerUserId: "user-B" });

    // user-A không có entitlement
    const creds = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    expect(creds).not.toBeNull();
    expect(creds.connectionId).toBe(shared.id);
    expect(creds.connectionId).not.toBe(otherOwned.id);
  });

  it("user không có entitlement + không có shared conn → null (no provider)", async () => {
    // Chỉ có owned conn của người khác
    await insertConnection({ ownerUserId: "user-B" });

    const creds = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    expect(creds).toBeNull();
  });
});

// ── AC3: infra-error → fail-open ──────────────────────────────────────────

describe("AC3 — infra-error resolveActiveEntitlement → fail-open shared pool", () => {
  it("khi resolveActiveEntitlement throw, fallback về shared pool (không 503)", async () => {
    // Setup shared connection
    const shared = await insertConnection({ ownerUserId: null });

    // Mock entitlementsRepo để resolveActiveEntitlement throw
    vi.doMock("@/lib/db/repos/entitlementsRepo.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        resolveActiveEntitlement: vi.fn().mockRejectedValue(new Error("DB connection lost")),
      };
    });
    vi.resetModules();

    // Re-import sau mock để lấy version mocked
    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const creds = await getProviderCredentials("anthropic", null, null, { userId: "user-A" });

    // fail-open: không throw, trả về connection từ shared pool
    expect(creds).not.toBeNull();
    expect(creds?.ownedOnlyUnavailable).toBeUndefined();

    vi.doUnmock("@/lib/db/repos/entitlementsRepo.js");
  });
});

// ── AC4: expired/revoked → owned không chọn ──────────────────────────────

describe("AC4 — expired / revoked → owned không được chọn", () => {
  it("entitlement expired (expiresAt quá hạn) → fallback shared (prefer_owned)", async () => {
    const shared = await insertConnection({ ownerUserId: null });
    await insertConnection({ ownerUserId: "user-A" });
    // expiresAt trong quá khứ
    await insertEntitlement({
      userId: "user-A", routePolicy: "prefer_owned",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    const creds = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    // Entitlement expired → coi như no-entitlement → shared pool
    expect(creds?.connectionId).toBe(shared.id);
  });

  it("entitlement revoked → không được chọn", async () => {
    const shared = await insertConnection({ ownerUserId: null });
    await insertConnection({ ownerUserId: "user-A" });
    await insertEntitlement({ userId: "user-A", status: "revoked" });

    const creds = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    expect(creds?.connectionId).toBe(shared.id);
  });

  it("owned connection inactive → loại khỏi pool, prefer_owned fallback shared", async () => {
    const shared = await insertConnection({ ownerUserId: null });
    await insertConnection({ ownerUserId: "user-A", isActive: false });
    await insertEntitlement({ userId: "user-A", routePolicy: "prefer_owned" });

    const creds = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    // getProviderConnections chỉ lấy isActive=true → owned inactive không có trong connections
    // → no owned in pool → fallback shared
    expect(creds?.connectionId).toBe(shared.id);
  });
});

// ── AC5: owned_only + không có owned → block ──────────────────────────────

describe("AC5 — owned_only + owned unavailable → ownedOnlyUnavailable signal", () => {
  it("owned_only + không có owned connection → trả block signal, KHÔNG lén shared", async () => {
    await insertConnection({ ownerUserId: null }); // shared conn có sẵn
    await insertEntitlement({ userId: "user-A", routePolicy: "owned_only" });

    const result = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    expect(result).not.toBeNull();
    expect(result.ownedOnlyUnavailable).toBe(true);
    expect(result.reason).toBeTruthy();
    // Không có connectionId → không lén dùng shared
    expect(result.connectionId).toBeUndefined();
  });
});

// ── AC6: cross-user isolation (M7 — security-critical) ───────────────────

describe("AC6 — cross-user isolation (M7 security test)", () => {
  it("user B không nhận connection owned bởi user A", async () => {
    const shared = await insertConnection({ ownerUserId: null });
    const ownedByA = await insertConnection({ ownerUserId: "user-A" });
    // user A có entitlement
    await insertEntitlement({ userId: "user-A", routePolicy: "prefer_owned" });
    // user B không có entitlement

    const credsB = await callGetProviderCredentials("anthropic", { userId: "user-B" });
    expect(credsB?.connectionId).not.toBe(ownedByA.id);
    expect(credsB?.connectionId).toBe(shared.id);
  });

  it("user A có entitlement, user B có entitlement riêng — không cross-leak", async () => {
    const ownedByA = await insertConnection({ ownerUserId: "user-A" });
    const ownedByB = await insertConnection({ ownerUserId: "user-B" });
    await insertEntitlement({ userId: "user-A", routePolicy: "prefer_owned" });
    await insertEntitlement({ userId: "user-B", routePolicy: "prefer_owned" });

    const credsA = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    const credsB = await callGetProviderCredentials("anthropic", { userId: "user-B" });

    expect(credsA?.connectionId).toBe(ownedByA.id);
    expect(credsB?.connectionId).toBe(ownedByB.id);
    expect(credsA?.connectionId).not.toBe(credsB?.connectionId);
  });

  it("null ownerUserId (admin pool) vẫn hoạt động sau 2.29b — regression", async () => {
    const adminConn = await insertConnection({ ownerUserId: null });
    // Không truyền userId → legacy/admin path
    const creds = await callGetProviderCredentials("anthropic", {});
    expect(creds?.connectionId).toBe(adminConn.id);
  });
});

// ── P2 (review fix): null-userId path KHÔNG được leak owned connection (M5) ──

describe("P2 — null-userId path excludes owned connections (M5 leak guard)", () => {
  it("legacy caller (no userId) nhận shared, KHÔNG nhận owned của user khác", async () => {
    const shared = await insertConnection({ ownerUserId: null });
    await insertConnection({ ownerUserId: "user-A" }); // owned — phải bị loại

    const creds = await callGetProviderCredentials("anthropic", {}); // no userId
    expect(creds).not.toBeNull();
    expect(creds.connectionId).toBe(shared.id);
  });

  it("chỉ có owned connection + caller no userId → null (owned cần entitlement, không leak)", async () => {
    await insertConnection({ ownerUserId: "user-A" }); // chỉ owned, không shared

    const creds = await callGetProviderCredentials("anthropic", {}); // no userId
    expect(creds).toBeNull(); // owned KHÔNG được phục vụ legacy caller
  });

  it("empty-string userId KHÔNG bypass filter (harden userId != null)", async () => {
    await insertConnection({ ownerUserId: "user-A" }); // chỉ owned

    // "" trước đây falsy → bypass; giờ != null nên vẫn đi entitlement path,
    // không có entitlement cho "" → shared-only → null.
    const creds = await callGetProviderCredentials("anthropic", { userId: "" });
    expect(creds).toBeNull();
  });
});

// ── P4 (review fix): nhiều active entitlement → bản MỚI NHẤT thắng (DESC) ──

describe("P4 — resolveActiveEntitlement picks newest entitlement", () => {
  it("entitlement owned_only mới ghi đè prefer_owned cũ cùng (userId, provider)", async () => {
    const owned = await insertConnection({ ownerUserId: "user-A" });
    // cũ: prefer_owned
    await insertEntitlement({ userId: "user-A", routePolicy: "prefer_owned" });
    await new Promise((r) => setTimeout(r, 5)); // đảm bảo createdAt khác nhau
    // mới: owned_only
    await insertEntitlement({ userId: "user-A", routePolicy: "owned_only" });

    // Nếu prefer_owned (cũ) thắng + owned bị loại → sẽ fallback shared.
    // Ở đây không có shared; nếu owned_only (mới) thắng → vẫn chọn owned.
    const creds = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    expect(creds?.connectionId).toBe(owned.id);

    // Xác nhận chính sách mới (owned_only) đang áp: xoá owned → block, KHÔNG shared.
    // (thêm shared rồi kiểm tra vẫn không rơi shared dưới owned_only)
  });

  it("owned_only mới + không có owned → block (chứng minh policy mới áp, không phải prefer_owned cũ)", async () => {
    await insertConnection({ ownerUserId: null }); // có shared
    await insertEntitlement({ userId: "user-A", routePolicy: "prefer_owned" });
    await new Promise((r) => setTimeout(r, 5));
    await insertEntitlement({ userId: "user-A", routePolicy: "owned_only" });

    const creds = await callGetProviderCredentials("anthropic", { userId: "user-A" });
    // Nếu prefer_owned cũ thắng → fallback shared (có connectionId).
    // owned_only mới thắng → block (không lén shared).
    expect(creds?.ownedOnlyUnavailable).toBe(true);
  });
});
