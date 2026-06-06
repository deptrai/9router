// Story 2.6 Task 5: GET /api/auth/verify-email tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-verifyEmail-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function makeRequest(token) {
  const url = token
    ? `http://localhost/api/auth/verify-email?token=${token}`
    : "http://localhost/api/auth/verify-email";
  return { url };
}

describe("GET /api/auth/verify-email", () => {
  async function seedUser(email = "verify@example.com") {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.hash("pass1234", 4);
    return createUser(email, hash, "Verify User");
  }

  it("valid token → isEmailVerified=true + { success:true }", async () => {
    const user = await seedUser();
    const { createEmailVerifyToken } = await import("@/lib/auth/emailVerifyToken.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");

    const token = await createEmailVerifyToken(user.id, user.email);

    const { GET } = await import("@/app/api/auth/verify-email/route.js");
    const res = await GET(makeRequest(token));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify DB was updated
    const updated = await getUserById(user.id);
    expect(updated.isEmailVerified).toBe(true);
  });

  it("invalid/wrong token → 400", async () => {
    const { GET } = await import("@/app/api/auth/verify-email/route.js");
    const res = await GET(makeRequest("totally-fake-token-abc"));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid or expired");
  });

  it("missing token → 400", async () => {
    const { GET } = await import("@/app/api/auth/verify-email/route.js");
    const res = await GET(makeRequest(null));

    expect(res.status).toBe(400);
  });

  it("token already consumed → 400 (one-time use)", async () => {
    const user = await seedUser("once@example.com");
    const { createEmailVerifyToken } = await import("@/lib/auth/emailVerifyToken.js");

    const token = await createEmailVerifyToken(user.id, user.email);

    const { GET } = await import("@/app/api/auth/verify-email/route.js");
    // First use
    await GET(makeRequest(token));
    // Second use → should fail
    const res = await GET(makeRequest(token));

    expect(res.status).toBe(400);
  });

  it("expired token → 400", async () => {
    const user = await seedUser("expired@example.com");
    const { createEmailVerifyToken } = await import("@/lib/auth/emailVerifyToken.js");
    const { makeKv } = await import("@/lib/db/helpers/kvStore.js");

    const token = await createEmailVerifyToken(user.id, user.email);
    // Override with past expiresAt
    const kv = makeKv("emailVerify");
    await kv.set(token, { userId: user.id, email: user.email, expiresAt: Date.now() - 1000 });

    const { GET } = await import("@/app/api/auth/verify-email/route.js");
    const res = await GET(makeRequest(token));

    expect(res.status).toBe(400);
  });
});
