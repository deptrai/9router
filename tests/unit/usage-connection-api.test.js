// Story N.3 — GET /api/usage/connection/:id auth + IDOR guard tests (D2)
// Verifies: no session → 401, invalid id → 400, not found → 404,
// non-admin non-owner → 403, admin/owner → 200 with stats, error → 500.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

function makeReq(url = "http://localhost/api/usage/connection/conn-1") {
  return { url, cookies: { get: () => undefined } };
}

function mockDeps({ session, role, connection, stats, throwInStats } = {}) {
  vi.doMock("@/lib/auth/requireRole", () => ({
    getSessionRole: vi.fn().mockResolvedValue({ session, role }),
  }));
  vi.doMock("@/lib/localDb", () => ({
    getProviderConnectionById: vi.fn().mockResolvedValue(connection),
  }));
  vi.doMock("@/lib/usageDb", () => ({
    getConnectionUsageStats: vi.fn().mockImplementation(() => {
      if (throwInStats) throw new Error("DB down");
      return stats ?? { today: { requests: 0, tokens: 0, cost: 0 }, last24h: { requests: 0, tokens: 0, cost: 0 }, last7d: { requests: 0, tokens: 0, cost: 0 }, allTime: { requests: 0, tokens: 0, cost: 0 }, perModel: [] };
    }),
  }));
}

describe("GET /api/usage/connection/:id — auth + IDOR guard (N.3 D2)", () => {
  it("no session → 401, never queries connection or stats", async () => {
    mockDeps({ session: null, role: "admin" });
    const { GET } = await import("@/app/api/usage/connection/[id]/route.js");
    const res = await GET(makeReq(), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(401);
    const { getProviderConnectionById } = await import("@/lib/localDb");
    expect(getProviderConnectionById).not.toHaveBeenCalled();
  });

  it("invalid id (non-alphanumeric) → 400", async () => {
    mockDeps({ session: { userId: "u-1" }, role: "admin" });
    const { GET } = await import("@/app/api/usage/connection/[id]/route.js");
    const res = await GET(makeReq("http://localhost/api/usage/connection/bad%20id"), {
      params: Promise.resolve({ id: "bad id" }),
    });
    expect(res.status).toBe(400);
  });

  it("id quá dài (>100 chars) → 400", async () => {
    mockDeps({ session: { userId: "u-1" }, role: "admin" });
    const { GET } = await import("@/app/api/usage/connection/[id]/route.js");
    const longId = "a".repeat(101);
    const res = await GET(makeReq(`http://localhost/api/usage/connection/${longId}`), {
      params: Promise.resolve({ id: longId }),
    });
    expect(res.status).toBe(400);
  });

  it("connection not found → 404", async () => {
    mockDeps({ session: { userId: "u-1" }, role: "admin", connection: null });
    const { GET } = await import("@/app/api/usage/connection/[id]/route.js");
    const res = await GET(makeReq(), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(404);
  });

  it("non-admin, connection có ownerUserId khác → 403 (IDOR blocked)", async () => {
    mockDeps({
      session: { userId: "u-1" },
      role: "user",
      connection: { id: "conn-1", provider: "windsurf", ownerUserId: "u-other" },
    });
    const { GET } = await import("@/app/api/usage/connection/[id]/route.js");
    const res = await GET(makeReq(), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(403);
  });

  it("non-admin, session không có userId → 403", async () => {
    mockDeps({
      session: {},
      role: "user",
      connection: { id: "conn-1", provider: "windsurf", ownerUserId: "u-other" },
    });
    const { GET } = await import("@/app/api/usage/connection/[id]/route.js");
    const res = await GET(makeReq(), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(403);
  });

  it("non-admin, owner match → 200 với stats", async () => {
    mockDeps({
      session: { userId: "u-1" },
      role: "user",
      connection: { id: "conn-1", name: "My Windsurf", provider: "windsurf", ownerUserId: "u-1" },
      stats: { today: { requests: 5, tokens: 1000, cost: 0.01 }, last24h: { requests: 10, tokens: 2000, cost: 0.02 }, last7d: { requests: 20, tokens: 4000, cost: 0.04 }, allTime: { requests: 50, tokens: 10000, cost: 0.1 }, perModel: [{ model: "gpt-4", tokens: 5000, requests: 25, cost: 0.05 }] },
    });
    const { GET } = await import("@/app/api/usage/connection/[id]/route.js");
    const res = await GET(makeReq(), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connectionId).toBe("conn-1");
    expect(body.name).toBe("My Windsurf");
    expect(body.provider).toBe("windsurf");
    expect(body.stats.today.requests).toBe(5);
  });

  it("admin → 200 với stats (bất kể ownerUserId)", async () => {
    mockDeps({
      session: { userId: "admin-1" },
      role: "admin",
      connection: { id: "conn-1", name: "Shared", provider: "windsurf", ownerUserId: "u-other" },
      stats: { today: { requests: 1, tokens: 100, cost: 0 }, last24h: { requests: 1, tokens: 100, cost: 0 }, last7d: { requests: 1, tokens: 100, cost: 0 }, allTime: { requests: 1, tokens: 100, cost: 0 }, perModel: [] },
    });
    const { GET } = await import("@/app/api/usage/connection/[id]/route.js");
    const res = await GET(makeReq(), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connectionId).toBe("conn-1");
  });

  it("DB error → 500, không leak raw error", async () => {
    mockDeps({
      session: { userId: "u-1" },
      role: "admin",
      connection: { id: "conn-1", provider: "windsurf" },
      throwInStats: true,
    });
    const { GET } = await import("@/app/api/usage/connection/[id]/route.js");
    const res = await GET(makeReq(), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch usage stats");
    expect(body.error).not.toContain("DB down");
  });

  it("ownerUserId null (shared admin pool) + non-admin → 403", async () => {
    mockDeps({
      session: { userId: "u-1" },
      role: "user",
      connection: { id: "conn-1", provider: "windsurf", ownerUserId: null },
    });
    const { GET } = await import("@/app/api/usage/connection/[id]/route.js");
    const res = await GET(makeReq(), { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(403);
  });
});
