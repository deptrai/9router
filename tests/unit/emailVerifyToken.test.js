// Story 2.6 Task 2+3: emailVerifyToken + requireEmailVerified tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-emailVerify-"));
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

describe("emailVerifyToken — create + consume", () => {
  it("create → consume OK (one-time use)", async () => {
    const { createEmailVerifyToken, consumeEmailVerifyToken } = await import("@/lib/auth/emailVerifyToken.js");

    const token = await createEmailVerifyToken("user-1", "user@example.com");
    expect(token).toBeTruthy();
    expect(token.length).toBe(64); // 32 bytes hex = 64 chars

    const result = await consumeEmailVerifyToken(token);
    expect(result).not.toBeNull();
    expect(result.userId).toBe("user-1");
    expect(result.email).toBe("user@example.com");

    // Second consume → null (one-time use)
    const result2 = await consumeEmailVerifyToken(token);
    expect(result2).toBeNull();
  });

  it("wrong/non-existent token → null", async () => {
    const { consumeEmailVerifyToken } = await import("@/lib/auth/emailVerifyToken.js");

    const result = await consumeEmailVerifyToken("nonexistent-token-xyz");
    expect(result).toBeNull();
  });

  it("null token → null", async () => {
    const { consumeEmailVerifyToken } = await import("@/lib/auth/emailVerifyToken.js");
    expect(await consumeEmailVerifyToken(null)).toBeNull();
  });

  it("expired token → null + cleaned up", async () => {
    const { createEmailVerifyToken, consumeEmailVerifyToken } = await import("@/lib/auth/emailVerifyToken.js");
    const { makeKv } = await import("@/lib/db/helpers/kvStore.js");

    const token = await createEmailVerifyToken("user-2", "exp@example.com");

    // Manually set expiresAt to the past
    const kv = makeKv("emailVerify");
    await kv.set(token, { userId: "user-2", email: "exp@example.com", expiresAt: Date.now() - 1000 });

    const result = await consumeEmailVerifyToken(token);
    expect(result).toBeNull();

    // Token should also be cleaned up
    const leftover = await kv.get(token, null);
    expect(leftover).toBeNull();
  });

  it("each token is unique (no collision in batch)", async () => {
    const { createEmailVerifyToken } = await import("@/lib/auth/emailVerifyToken.js");

    const tokens = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createEmailVerifyToken(`user-${i}`, `u${i}@example.com`))
    );
    const unique = new Set(tokens);
    expect(unique.size).toBe(10);
  });
});

describe("requireEmailVerified", () => {
  async function seedUser(email, isEmailVerified = false) {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");

    const hash = await bcrypt.hash("pass", 4);
    const user = await createUser(email, hash, "User");

    if (isEmailVerified) {
      const db = await getAdapter();
      db.run(`UPDATE users SET isEmailVerified = 1 WHERE id = ?`, [user.id]);
    }
    return user;
  }

  it("verified user → true", async () => {
    const user = await seedUser("verified@example.com", true);
    const { requireEmailVerified } = await import("@/lib/auth/requireEmailVerified.js");
    expect(await requireEmailVerified(user.id)).toBe(true);
  });

  it("unverified user → false", async () => {
    const user = await seedUser("unverified@example.com", false);
    const { requireEmailVerified } = await import("@/lib/auth/requireEmailVerified.js");
    expect(await requireEmailVerified(user.id)).toBe(false);
  });

  it("non-existent userId → false", async () => {
    const { requireEmailVerified } = await import("@/lib/auth/requireEmailVerified.js");
    expect(await requireEmailVerified("ghost-id")).toBe(false);
  });

  it("null userId → false", async () => {
    const { requireEmailVerified } = await import("@/lib/auth/requireEmailVerified.js");
    expect(await requireEmailVerified(null)).toBe(false);
  });
});
