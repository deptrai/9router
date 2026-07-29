import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status ?? 200,
    json: async () => body,
  })),
  requireAdmin: vi.fn(),
  runDuePurchases: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: mocks.jsonResponse,
  },
}));

vi.mock("@/lib/auth/requireRole", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/store/purchaseWorker", () => ({
  runDuePurchases: mocks.runDuePurchases,
}));

const adminSession = { userId: "admin-1", role: "admin" };

function makeRequest() {
  return new Request("http://localhost/api/store/admin/run-purchases", {
    method: "POST",
  });
}

describe("POST /api/store/admin/run-purchases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.requireAdmin.mockResolvedValue(adminSession);
    mocks.runDuePurchases.mockResolvedValue({ processed: 3, failed: 0 });
  });

  it("succeeds and returns result from runDuePurchases", async () => {
    const { POST } = await import("@/app/api/store/admin/run-purchases/route.js");
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 3, failed: 0 });
    expect(mocks.runDuePurchases).toHaveBeenCalledTimes(1);
  });

  it("returns 429 when called within the 30s cooldown", async () => {
    const { POST } = await import("@/app/api/store/admin/run-purchases/route.js");
    const res1 = await POST(makeRequest());
    expect(res1.status).toBe(200);

    const res2 = await POST(makeRequest());
    expect(res2.status).toBe(429);
    expect(await res2.json()).toMatchObject({ error: "Purchase sweep is cooling down" });
    expect(mocks.runDuePurchases).toHaveBeenCalledTimes(1);
  });

  it("returns 403 for non-admin session", async () => {
    mocks.requireAdmin.mockResolvedValue(null);
    const { POST } = await import("@/app/api/store/admin/run-purchases/route.js");
    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
    expect(mocks.runDuePurchases).not.toHaveBeenCalled();
  });
});
