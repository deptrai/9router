// Story M.3 — PATCH /api/users/[id]/status guard tests
// Verifies: non-admin → 403, self-disable → 400, valid toggle → 200, missing user → 404.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

function makeReq(body) {
  return {
    cookies: { get: () => ({ value: "tok" }) },
    json: async () => body,
  };
}

const ctx = (id) => ({ params: Promise.resolve({ id }) });

describe("PATCH /api/users/[id]/status — admin guard (M.3)", () => {
  it("non-admin (requireAdmin → null) → 403", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({ requireAdmin: vi.fn().mockResolvedValue(null) }));
    vi.doMock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));
    const { PATCH } = await import("@/app/api/users/[id]/status/route.js");
    const res = await PATCH(makeReq({ isActive: false }), ctx("other-user"));
    expect(res.status).toBe(403);
  });

  it("admin disabling own account → 400 (self-disable guard)", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-1", role: "admin" }),
    }));
    const run = vi.fn();
    vi.doMock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn().mockResolvedValue({ run, get: vi.fn() }) }));
    const { PATCH } = await import("@/app/api/users/[id]/status/route.js");
    const res = await PATCH(makeReq({ isActive: false }), ctx("admin-1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/own account/i);
    // Guard must short-circuit before any DB write.
    expect(run).not.toHaveBeenCalled();
  });

  it("admin disabling another user → 200 + isActive false", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-1", role: "admin" }),
    }));
    const run = vi.fn();
    const get = vi.fn().mockReturnValue({ id: "u2", email: "u2@x.dev", displayName: "U2", isActive: 0 });
    vi.doMock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn().mockResolvedValue({ run, get }) }));
    const { PATCH } = await import("@/app/api/users/[id]/status/route.js");
    const res = await PATCH(makeReq({ isActive: false }), ctx("u2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.isActive).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("admin patching non-existent user → 404", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-1", role: "admin" }),
    }));
    const get = vi.fn().mockReturnValue(undefined);
    vi.doMock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn().mockResolvedValue({ run: vi.fn(), get }) }));
    const { PATCH } = await import("@/app/api/users/[id]/status/route.js");
    const res = await PATCH(makeReq({ isActive: true }), ctx("ghost"));
    expect(res.status).toBe(404);
  });
});
