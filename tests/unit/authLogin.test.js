// Story 2.2 Task 3: POST /api/auth/login — user branch + admin branch tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-authLogin-"));
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = "test-secret-for-login";
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  delete process.env.JWT_SECRET;
});

// Mock next/headers cookies
const mockCookieSet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve({
    set: mockCookieSet,
    get: vi.fn(),
    delete: vi.fn(),
  })),
}));

// Mock loginLimiter — never locked for these tests
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: vi.fn(() => ({ locked: false })),
  recordFail: vi.fn(() => ({ remainingBeforeLock: 4 })),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

// Mock getSettings — returns admin password hash
const adminHash = bcrypt.hashSync("adminpass123", 10);
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(() => Promise.resolve({
    password: adminHash,
    authMode: "password",
    requireLogin: true,
  })),
}));

// Mock OIDC
vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: vi.fn(() => false),
}));

describe("POST /api/auth/login", () => {
  function makeRequest(body) {
    return {
      json: () => Promise.resolve(body),
      headers: new Map([["host", "localhost:3000"]]),
    };
  }

  it("user login: valid email + password → success", async () => {
    // Create a user first
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

  it("admin login: valid password → success (unchanged behavior)", async () => {
    const { POST } = await import("@/app/api/auth/login/route.js");
    const res = await POST(makeRequest({ password: "adminpass123" }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("admin login: wrong password → 401", async () => {
    const { POST } = await import("@/app/api/auth/login/route.js");
    const res = await POST(makeRequest({ password: "wrongadmin" }));

    expect(res.status).toBe(401);
  });
});
