// Story 2.6 Task 6: POST /api/auth/send-verification tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let mockSession = null;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sendVerif-"));
  process.env.DATA_DIR = tempDir;
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
});

// Mock cookies
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve({
    set: vi.fn(),
    get: vi.fn(name => name === "auth_token" ? { value: "mock-token" } : undefined),
    delete: vi.fn(),
  })),
}));

// Mock getDashboardAuthSession
vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: vi.fn(async () => mockSession),
  setDashboardAuthCookie: vi.fn(),
  verifyDashboardAuthToken: vi.fn(async () => true),
}));

// Mock loginLimiter — never locked
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: vi.fn(() => ({ locked: false })),
  recordFail: vi.fn(() => ({ remainingBeforeLock: 4 })),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

// Mock sendEmail to avoid real HTTP calls
const mockSendEmail = vi.fn(async () => ({ sent: false, skipped: true }));
vi.mock("@/lib/email/sendEmail.js", () => ({
  sendEmail: (...args) => mockSendEmail(...args),
}));

describe("POST /api/auth/send-verification", () => {
  async function seedUser(email = "sv@example.com", isEmailVerified = false) {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const hash = await bcrypt.hash("pass1234", 4);
    const user = await createUser(email, hash, "User");
    if (isEmailVerified) {
      const db = await getAdapter();
      db.run(`UPDATE users SET isEmailVerified = 1 WHERE id = ?`, [user.id]);
    }
    return user;
  }

  it("unverified user → sends email (sendEmail called)", async () => {
    const user = await seedUser("unverif@example.com", false);
    mockSession = { role: "user", userId: user.id, email: user.email };
    mockSendEmail.mockClear();

    const { POST } = await import("@/app/api/auth/send-verification/route.js");
    const res = await POST({ headers: new Map() });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.alreadyVerified).toBeUndefined();
    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockSendEmail.mock.calls[0][0].to).toBe("unverif@example.com");
    // Anti email-bomb: each send must be counted against the IP limiter (regression guard)
    const { recordFail } = await import("@/lib/auth/loginLimiter");
    expect(recordFail).toHaveBeenCalled();
  });

  it("already verified → { alreadyVerified:true } (no email sent)", async () => {
    const user = await seedUser("already@example.com", true);
    mockSession = { role: "user", userId: user.id, email: user.email };
    mockSendEmail.mockClear();

    const { POST } = await import("@/app/api/auth/send-verification/route.js");
    const res = await POST({ headers: new Map() });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.alreadyVerified).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("role=admin → 403", async () => {
    mockSession = { role: "admin" };

    const { POST } = await import("@/app/api/auth/send-verification/route.js");
    const res = await POST({ headers: new Map() });

    expect(res.status).toBe(403);
  });

  it("no session → 403", async () => {
    mockSession = null;

    const { POST } = await import("@/app/api/auth/send-verification/route.js");
    const res = await POST({ headers: new Map() });

    expect(res.status).toBe(403);
  });
});
