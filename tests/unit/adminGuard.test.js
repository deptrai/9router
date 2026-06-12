// Story 2.5 Task 5: route guard admin-only (AC4)
// Tests that admin-only API routes return 403 for non-admin users
// and pass for admin/legacy (no-role) tokens.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-adminGuard-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  vi.resetModules();
});

// Helper to create a minimal Next.js-like request
function makeReq(cookieVal) {
  return { cookies: { get: () => cookieVal ? { value: cookieVal } : undefined } };
}

// --- requireAdmin helper logic tests (AC4) ---
describe("requireAdmin helper — AC4 role logic", () => {
  it("admin role → returns session", async () => {
    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({ userId: "u1", role: "admin" }),
    }));
    const { requireAdmin } = await import("@/lib/auth/requireRole");
    const result = await requireAdmin(makeReq("tok"));
    expect(result).not.toBeNull();
    expect(result.role).toBe("admin");
  });

  it("user role → returns null (blocked)", async () => {
    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({ userId: "u2", role: "user" }),
    }));
    const { requireAdmin } = await import("@/lib/auth/requireRole");
    const result = await requireAdmin(makeReq("tok"));
    expect(result).toBeNull();
  });

  it("legacy token (no role field) → treated as admin (backward-compat)", async () => {
    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({ userId: "u3" }), // no role
    }));
    const { requireAdmin } = await import("@/lib/auth/requireRole");
    const result = await requireAdmin(makeReq("tok"));
    expect(result).not.toBeNull(); // legacy → admin
  });

  it("no token (no session) → returns null (denied, AC9/NFR2)", async () => {
    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue(null),
    }));
    const { requireAdmin } = await import("@/lib/auth/requireRole");
    // AC9: no valid session → denied (the no-token→admin shim was removed).
    const result = await requireAdmin(makeReq(null));
    expect(result).toBeNull();
  });
});

// --- /api/users route guard (AC3 + AC4) ---
describe("/api/users route — role guard", () => {
  it("user role → GET returns 403", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue(null),
      getSessionRole: vi.fn().mockResolvedValue({ session: null, role: "user" }),
    }));
    const { GET } = await import("@/app/api/users/route.js");
    const res = await GET(makeReq("user-tok"));
    expect(res.status).toBe(403);
  });

  it("admin role → GET returns 200", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin", role: "admin" }),
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "admin", role: "admin" }, role: "admin" }),
    }));
    const { GET } = await import("@/app/api/users/route.js");
    const res = await GET(makeReq("admin-tok"));
    expect(res.status).toBe(200);
  });
});

// --- /api/users/[id]/credits route guard ---
describe("/api/users/[id]/credits route — role guard", () => {
  it("user role → PUT returns 403", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue(null),
      getSessionRole: vi.fn().mockResolvedValue({ session: null, role: "user" }),
    }));
    const { PUT } = await import("@/app/api/users/[id]/credits/route.js");
    const req = { ...makeReq("user-tok"), json: async () => ({ amount: 5 }) };
    const res = await PUT(req, { params: { id: "any-id" } });
    expect(res.status).toBe(403);
  });
});

// --- /api/settings/database route guard (CRITICAL: full DB export/import) ---
describe("/api/settings/database route — role guard (CRITICAL)", () => {
  it("user role → GET (exportDb) returns 403", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue(null),
      getSessionRole: vi.fn().mockResolvedValue({ session: null, role: "user" }),
    }));
    const { GET } = await import("@/app/api/settings/database/route.js");
    const res = await GET(makeReq("user-tok"));
    expect(res.status).toBe(403);
  });

  it("user role → POST (importDb) returns 403", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue(null),
      getSessionRole: vi.fn().mockResolvedValue({ session: null, role: "user" }),
    }));
    const { POST } = await import("@/app/api/settings/database/route.js");
    const req = { ...makeReq("user-tok"), json: async () => ({ apiKeys: [] }) };
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});

// --- requireRole module source-code check: providers/settings guards (AC4) ---
describe("admin-only route files — requireAdmin import present", () => {
  it("providers route GET imports requireAdmin and uses it", async () => {
    // Source inspection: just verify the guard call exists in the route files
    const providersContent = fs.readFileSync(
      path.join(process.cwd(), "src/app/api/providers/route.js"),
      "utf8"
    );
    expect(providersContent).toContain("requireAdmin");
  });

  it("settings route imports requireAdmin", async () => {
    const settingsContent = fs.readFileSync(
      path.join(process.cwd(), "src/app/api/settings/route.js"),
      "utf8"
    );
    expect(settingsContent).toContain("requireAdmin");
  });
});
