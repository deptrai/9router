// Story 2.2 Task 2: POST /api/auth/register tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-authRegister-"));
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = "test-secret-for-register";
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
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve({
    set: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  })),
}));

describe("POST /api/auth/register", () => {
  function makeRequest(body) {
    return {
      json: () => Promise.resolve(body),
      headers: new Map([["host", "localhost:3000"]]),
    };
  }

  it("happy path: registers user and returns success", async () => {
    const { POST } = await import("@/app/api/auth/register/route.js");

    const res = await POST(makeRequest({
      email: "new@example.com",
      password: "password123",
      displayName: "New User",
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.userId).toBeTruthy();
    expect(data.email).toBe("new@example.com");
  });

  it("registers with default displayName from email", async () => {
    const { POST } = await import("@/app/api/auth/register/route.js");

    const res = await POST(makeRequest({
      email: "john.doe@example.com",
      password: "password123",
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify displayName was set from email
    const { getUserByEmail } = await import("@/lib/db/repos/usersRepo.js");
    const user = await getUserByEmail("john.doe@example.com");
    expect(user.displayName).toBe("john.doe");
  });

  it("duplicate email → 409", async () => {
    const { POST } = await import("@/app/api/auth/register/route.js");

    // First registration
    await POST(makeRequest({
      email: "dup@example.com",
      password: "password123",
    }));

    // Second attempt with same email
    const res = await POST(makeRequest({
      email: "dup@example.com",
      password: "password456",
    }));

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("already");
  });

  it("weak password (< 8 chars) → 400", async () => {
    const { POST } = await import("@/app/api/auth/register/route.js");

    const res = await POST(makeRequest({
      email: "weak@example.com",
      password: "short",
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("8 characters");
  });

  it("missing email → 400", async () => {
    const { POST } = await import("@/app/api/auth/register/route.js");

    const res = await POST(makeRequest({
      password: "password123",
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("email");
  });

  it("invalid email format → 400", async () => {
    const { POST } = await import("@/app/api/auth/register/route.js");

    const res = await POST(makeRequest({
      email: "not-an-email",
      password: "password123",
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("email");
  });

  it("missing password → 400", async () => {
    const { POST } = await import("@/app/api/auth/register/route.js");

    const res = await POST(makeRequest({
      email: "test@example.com",
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("8 characters");
  });

  it("password is hashed with bcrypt (not stored plaintext)", async () => {
    const { POST } = await import("@/app/api/auth/register/route.js");

    await POST(makeRequest({
      email: "hash@example.com",
      password: "mySecurePassword",
    }));

    const { getUserByEmail } = await import("@/lib/db/repos/usersRepo.js");
    const user = await getUserByEmail("hash@example.com");
    expect(user.passwordHash).not.toBe("mySecurePassword");
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt hash prefix
  });
});
