// Story 2.5 Task 4: admin users list + topup API (AC3)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-adminTopup-"));
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

async function seedUser(email = "test@test.com", initialBalance = 5.0) {
  const bcrypt = await import("bcryptjs");
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const hash = await bcrypt.default.hash("pass", 4);
  const user = await createUser(email, hash, "Test User");
  const db = await getAdapter();
  db.run(`UPDATE users SET creditsBalance = ? WHERE id = ?`, [initialBalance, user.id]);
  return user;
}

describe("GET /api/users — admin list (AC3)", () => {
  it("admin → returns users list without passwordHash", async () => {
    await seedUser("alice@test.com");
    await seedUser("bob@test.com");

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "admin-id", role: "admin" }, role: "admin" }),
    }));

    const { GET } = await import("@/app/api/users/route.js");
    const req = { cookies: { get: () => ({ value: "admin-token" }) } };
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(data.users)).toBe(true);
    expect(data.users.length).toBeGreaterThanOrEqual(2);
    for (const u of data.users) {
      expect(u.passwordHash).toBeUndefined();
      expect(u.email).toBeTruthy();
    }
  });

  it("non-admin → 403", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue(null),
      getSessionRole: vi.fn().mockResolvedValue({ session: null, role: "user" }),
    }));

    const { GET } = await import("@/app/api/users/route.js");
    const req = { cookies: { get: () => ({ value: "user-token" }) } };
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/users/[id]/credits — topup (AC3)", () => {
  it("admin topup positive amount → balance increases", async () => {
    const user = await seedUser("credits@test.com", 5.0);

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "admin-id", role: "admin" }, role: "admin" }),
    }));

    const { PUT } = await import("@/app/api/users/[id]/credits/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ amount: 10.0 }),
    };
    const res = await PUT(req, { params: { id: user.id } });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.newBalance).toBeCloseTo(15.0, 5);
  });

  it("admin topup writes ledger row with note and admin refId", async () => {
    const user = await seedUser("ledger-note@test.com", 1.0);

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "admin-id", role: "admin" }, role: "admin" }),
    }));

    const { PUT } = await import("@/app/api/users/[id]/credits/route.js");
    const { getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ amount: 4.0, note: "manual adjustment" }),
    };
    const res = await PUT(req, { params: { id: user.id } });
    const rows = await getLedgerByUser(user.id);

    expect(res.status).toBe(200);
    expect(rows[0]).toMatchObject({
      type: "admin_topup",
      bucket: "standard",
      amount: 4,
      refId: "admin-id",
      note: "manual adjustment",
    });
  });

  it("admin topup negative amount → balance decreases", async () => {
    const user = await seedUser("neg@test.com", 10.0);

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "admin-id", role: "admin" }, role: "admin" }),
    }));

    const { PUT } = await import("@/app/api/users/[id]/credits/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ amount: -3.0 }),
    };
    const res = await PUT(req, { params: { id: user.id } });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.newBalance).toBeCloseTo(7.0, 5);
  });

  it("non-admin → 403", async () => {
    const user = await seedUser("guard@test.com");

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue(null),
      getSessionRole: vi.fn().mockResolvedValue({ session: null, role: "user" }),
    }));

    const { PUT } = await import("@/app/api/users/[id]/credits/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ amount: 5.0 }),
    };
    const res = await PUT(req, { params: { id: user.id } });
    expect(res.status).toBe(403);
  });

  it("user not found → 404", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "admin-id", role: "admin" }, role: "admin" }),
    }));

    const { PUT } = await import("@/app/api/users/[id]/credits/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ amount: 5.0 }),
    };
    const res = await PUT(req, { params: { id: "non-existent-id" } });
    expect(res.status).toBe(404);
  });

  it("invalid amount (NaN) → 400", async () => {
    const user = await seedUser("nan@test.com");

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
      getSessionRole: vi.fn().mockResolvedValue({ session: { userId: "admin-id", role: "admin" }, role: "admin" }),
    }));

    const { PUT } = await import("@/app/api/users/[id]/credits/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ amount: "abc" }),
    };
    const res = await PUT(req, { params: { id: user.id } });
    expect(res.status).toBe(400);
  });
});
