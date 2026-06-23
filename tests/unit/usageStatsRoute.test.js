// Story M.1/M.4 — GET /api/usage/stats auth guard tests
// Verifies the route-level backstop: null session → 401 (never falls through to
// admin/all-users path), user role → scoped to own userId, admin → optional drill-down.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

function makeReq(url = "http://localhost/api/usage/stats?period=7d") {
  return { url, cookies: { get: () => undefined } };
}

describe("GET /api/usage/stats — auth guard (M.1/M.4)", () => {
  it("no session → 401, never queries stats (no all-users leak)", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      getSessionRole: vi.fn().mockResolvedValue({ session: null, role: "admin" }),
    }));
    const getUsageStats = vi.fn();
    vi.doMock("@/lib/usageDb", () => ({ getUsageStats }));
    const { GET } = await import("@/app/api/usage/stats/route.js");
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    // Critical: must short-circuit before hitting the data layer.
    expect(getUsageStats).not.toHaveBeenCalled();
  });

  it("user role → getUsageStats called with own userId", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "u-42" }, role: "user" }),
    }));
    const getUsageStats = vi.fn().mockResolvedValue({ totalRequests: 0 });
    vi.doMock("@/lib/usageDb", () => ({ getUsageStats }));
    const { GET } = await import("@/app/api/usage/stats/route.js");
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(getUsageStats).toHaveBeenCalledWith("7d", "u-42");
  });

  it("user role → cannot drill-down others via ?userId (param ignored)", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "u-42" }, role: "user" }),
    }));
    const getUsageStats = vi.fn().mockResolvedValue({ totalRequests: 0 });
    vi.doMock("@/lib/usageDb", () => ({ getUsageStats }));
    const { GET } = await import("@/app/api/usage/stats/route.js");
    await GET(makeReq("http://localhost/api/usage/stats?period=7d&userId=victim"));
    expect(getUsageStats).toHaveBeenCalledWith("7d", "u-42");
  });

  it("admin → ?userId drill-down honored", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "admin-1" }, role: "admin" }),
    }));
    const getUsageStats = vi.fn().mockResolvedValue({ totalRequests: 1 });
    vi.doMock("@/lib/usageDb", () => ({ getUsageStats }));
    const { GET } = await import("@/app/api/usage/stats/route.js");
    await GET(makeReq("http://localhost/api/usage/stats?period=30d&userId=target"));
    expect(getUsageStats).toHaveBeenCalledWith("30d", "target");
  });

  it("admin without ?userId → all-users (userId null)", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "admin-1" }, role: "admin" }),
    }));
    const getUsageStats = vi.fn().mockResolvedValue({ totalRequests: 5 });
    vi.doMock("@/lib/usageDb", () => ({ getUsageStats }));
    const { GET } = await import("@/app/api/usage/stats/route.js");
    await GET(makeReq("http://localhost/api/usage/stats?period=7d"));
    expect(getUsageStats).toHaveBeenCalledWith("7d", null);
  });

  it("invalid period → 400 before auth path", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({ getSessionRole: vi.fn() }));
    const getUsageStats = vi.fn();
    vi.doMock("@/lib/usageDb", () => ({ getUsageStats }));
    const { GET } = await import("@/app/api/usage/stats/route.js");
    const res = await GET(makeReq("http://localhost/api/usage/stats?period=bogus"));
    expect(res.status).toBe(400);
    expect(getUsageStats).not.toHaveBeenCalled();
  });
});
