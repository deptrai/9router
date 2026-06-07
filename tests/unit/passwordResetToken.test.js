// Story 2.7 Task 1: passwordResetToken tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pwReset-"));
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

describe("passwordResetToken", () => {
  it("create → consume OK (one-time)", async () => {
    const { createPasswordResetToken, consumePasswordResetToken } = await import("@/lib/auth/passwordResetToken.js");
    const token = await createPasswordResetToken("user-1", "u@example.com");
    expect(token.length).toBe(64);

    const result = await consumePasswordResetToken(token);
    expect(result).toEqual({ userId: "user-1", email: "u@example.com" });

    // Second consume → null
    expect(await consumePasswordResetToken(token)).toBeNull();
  });

  it("invalid token → null", async () => {
    const { consumePasswordResetToken } = await import("@/lib/auth/passwordResetToken.js");
    expect(await consumePasswordResetToken("fake-token")).toBeNull();
  });

  it("null token → null", async () => {
    const { consumePasswordResetToken } = await import("@/lib/auth/passwordResetToken.js");
    expect(await consumePasswordResetToken(null)).toBeNull();
  });

  it("expired token (TTL 1h) → null", async () => {
    const { createPasswordResetToken, consumePasswordResetToken } = await import("@/lib/auth/passwordResetToken.js");
    const { makeKv } = await import("@/lib/db/helpers/kvStore.js");

    const token = await createPasswordResetToken("user-2", "exp@example.com");
    const kv = makeKv("passwordReset");
    await kv.set(token, { userId: "user-2", email: "exp@example.com", expiresAt: Date.now() - 1000 });

    expect(await consumePasswordResetToken(token)).toBeNull();
  });
});
