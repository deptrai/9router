// Story 2.2 Task 5: GET/PATCH /api/users/me tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let mockSession = null;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usersMe-"));
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = "test-secret-for-me";
  delete global._dbAdapter;
  vi.resetModules();
  mockSession = null;
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
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve({
    set: vi.fn(),
    get: vi.fn((name) => {
      if (name === "auth_token") return { value: "mock-token" };
      return undefined;
    }),
    delete: vi.fn(),
  })),
}));

// Mock getDashboardAuthSession to return mockSession
vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: vi.fn(async () => mockSession),
  setDashboardAuthCookie: vi.fn(),
  verifyDashboardAuthToken: vi.fn(async () => true),
}));

describe("GET /api/users/me", () => {
  it("returns user profile for role=user", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.hash("pass1234", 10);
    const user = await createUser("me@example.com", hash, "Me User");

    mockSession = { role: "user", userId: user.id, email: "me@example.com" };

    const { GET } = await import("@/app/api/users/me/route.js");
    const res = await GET();

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(user.id);
    expect(data.email).toBe("me@example.com");
    expect(data.displayName).toBe("Me User");
    expect(data.creditsBalance).toBe(0);
    expect(data.isEmailVerified).toBe(false);
    expect(data.createdAt).toBeTruthy();
    // passwordHash should NOT be exposed
    expect(data.passwordHash).toBeUndefined();
  });

  it("returns 403 for role=admin", async () => {
    mockSession = { role: "admin" };

    const { GET } = await import("@/app/api/users/me/route.js");
    const res = await GET();

    expect(res.status).toBe(403);
  });

  it("returns 403 for no session", async () => {
    mockSession = null;

    const { GET } = await import("@/app/api/users/me/route.js");
    const res = await GET();

    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/users/me", () => {
  function makeRequest(body) {
    return {
      json: () => Promise.resolve(body),
    };
  }

  it("updates displayName", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.hash("pass1234", 10);
    const user = await createUser("patch@example.com", hash, "Old Name");

    mockSession = { role: "user", userId: user.id, email: "patch@example.com" };

    const { PATCH } = await import("@/app/api/users/me/route.js");
    const res = await PATCH(makeRequest({ displayName: "New Name" }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.displayName).toBe("New Name");
  });

  it("changes password with correct currentPassword", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.hash("oldpass123", 10);
    const user = await createUser("chpass@example.com", hash, "ChPass");

    mockSession = { role: "user", userId: user.id, email: "chpass@example.com" };

    const { PATCH } = await import("@/app/api/users/me/route.js");
    const res = await PATCH(makeRequest({
      currentPassword: "oldpass123",
      newPassword: "newpass456",
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify new password works
    const { getUserByEmail } = await import("@/lib/db/repos/usersRepo.js");
    const updated = await getUserByEmail("chpass@example.com");
    const valid = await bcrypt.compare("newpass456", updated.passwordHash);
    expect(valid).toBe(true);
  });

  it("returns 401 for wrong currentPassword", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.hash("correct123", 10);
    const user = await createUser("wrongcp@example.com", hash, "WrongCP");

    mockSession = { role: "user", userId: user.id, email: "wrongcp@example.com" };

    const { PATCH } = await import("@/app/api/users/me/route.js");
    const res = await PATCH(makeRequest({
      currentPassword: "wrongpass",
      newPassword: "newpass456",
    }));

    expect(res.status).toBe(401);
  });

  it("returns 403 for role=admin", async () => {
    mockSession = { role: "admin" };

    const { PATCH } = await import("@/app/api/users/me/route.js");
    const res = await PATCH(makeRequest({ displayName: "Hacker" }));

    expect(res.status).toBe(403);
  });
});
