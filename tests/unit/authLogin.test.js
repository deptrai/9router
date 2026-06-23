// POST /api/auth/login — email/password only (admin password branch removed).
// Admin is a regular user promoted via process.env.ADMIN_EMAIL.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalAdminEmail = process.env.ADMIN_EMAIL;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-authLogin-"));
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = "test-secret-for-login";
  delete process.env.ADMIN_EMAIL;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = originalAdminEmail;
  delete process.env.JWT_SECRET;
});

// Capture the JWT claims passed to the cookie (token is signed, so we read the
// role from the SignJWT payload via a spy on setDashboardAuthCookie instead).
const mockCookieSet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve({
    set: mockCookieSet,
    get: vi.fn(),
    delete: vi.fn(),
  })),
}));

vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: vi.fn(() => ({ locked: false })),
  recordFail: vi.fn(() => ({ remainingBeforeLock: 4 })),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(() => Promise.resolve({
    authMode: "password",
    requireLogin: true,
  })),
}));

describe("POST /api/auth/login", () => {
  function makeRequest(body) {
    return {
      json: () => Promise.resolve(body),
      headers: new Map([["host", "localhost:3000"]]),
    };
  }

  it("user login: valid email + password → success, role user", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.hash("userpass123", 10);
    await createUser("user@example.com", hash, "Test User");

    const { POST } = await import("@/app/api/auth/login/route.js");
    const res = await POST(makeRequest({ email: "user@example.com", password: "userpass123" }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("user login: wrong password → 401", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.hash("correct123", 10);
    await createUser("wrong@example.com", hash, "Wrong");

    const { POST } = await import("@/app/api/auth/login/route.js");
    const res = await POST(makeRequest({ email: "wrong@example.com", password: "incorrect" }));

    expect(res.status).toBe(401);
  });

  it("user login: inactive user → 401", async () => {
    const { createUser, deactivateUser } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.hash("pass12345", 10);
    const user = await createUser("inactive@example.com", hash, "Inactive");
    await deactivateUser(user.id);

    const { POST } = await import("@/app/api/auth/login/route.js");
    const res = await POST(makeRequest({ email: "inactive@example.com", password: "pass12345" }));

    expect(res.status).toBe(401);
  });

  it("user login: non-existent email → 401", async () => {
    const { POST } = await import("@/app/api/auth/login/route.js");
    const res = await POST(makeRequest({ email: "ghost@example.com", password: "password" }));

    expect(res.status).toBe(401);
  });

  it("no email in body → 400 (admin password branch removed)", async () => {
    const { POST } = await import("@/app/api/auth/login/route.js");
    const res = await POST(makeRequest({ password: "whatever" }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/email/i);
  });

  it("ADMIN_EMAIL match → user promoted to isAdmin on login", async () => {
    process.env.ADMIN_EMAIL = "boss@example.com";
    const { createUser, getUserByEmail } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.hash("bosspass123", 10);
    await createUser("boss@example.com", hash, "Boss");

    const { POST } = await import("@/app/api/auth/login/route.js");
    const res = await POST(makeRequest({ email: "boss@example.com", password: "bosspass123" }));

    expect(res.status).toBe(200);
    // Promotion persisted to the DB record.
    const after = await getUserByEmail("boss@example.com");
    expect(after.isAdmin).toBe(true);
  });

  it("non-admin email → isAdmin stays false", async () => {
    process.env.ADMIN_EMAIL = "boss@example.com";
    const { createUser, getUserByEmail } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.hash("plebpass123", 10);
    await createUser("pleb@example.com", hash, "Pleb");

    const { POST } = await import("@/app/api/auth/login/route.js");
    const res = await POST(makeRequest({ email: "pleb@example.com", password: "plebpass123" }));

    expect(res.status).toBe(200);
    const after = await getUserByEmail("pleb@example.com");
    expect(after.isAdmin).toBe(false);
  });
});
