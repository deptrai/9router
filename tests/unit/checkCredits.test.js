// Story 2.4 Task 2: checkCredits module tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-checkCredits-"));
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

async function seedUserKey(email, balance, isActive = true) {
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");

  const hash = await bcrypt.hash("pass12345", 4);
  const user = await createUser(email, hash, "User");

  const db = await getAdapter();
  if (balance > 0) {
    // Seed via ledger so getBalanceByBucket (used by checkCredits) sees the balance
    await recordCreditTxn({ userId: user.id, type: "admin_topup", bucket: "standard", amount: balance, refId: `seed:${email}` }, null);
  } else {
    db.run(`UPDATE users SET creditsBalance = ? WHERE id = ?`, [balance, user.id]);
  }
  if (!isActive) {
    db.run(`UPDATE users SET isActive = 0 WHERE id = ?`, [user.id]);
  }

  const key = await createApiKey("key", "machine-1", user.id);
  return { user, key };
}

describe("checkCredits", () => {
  it("null apiKey → allowed (fail-open)", async () => {
    const { checkCredits } = await import("@/lib/billing/checkCredits.js");
    const result = await checkCredits(null);
    expect(result.allowed).toBe(true);
  });

  it("empty string apiKey → allowed", async () => {
    const { checkCredits } = await import("@/lib/billing/checkCredits.js");
    const result = await checkCredits("");
    expect(result.allowed).toBe(true);
  });

  it("key not found → allowed (fail-open)", async () => {
    const { checkCredits } = await import("@/lib/billing/checkCredits.js");
    const result = await checkCredits("sk-nonexistent-key");
    expect(result.allowed).toBe(true);
  });

  it("legacy key (userId=null) → allowed (unlimited)", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    await createApiKey("legacy", "machine-2"); // no userId

    // Get the key string
    const { getApiKeys } = await import("@/lib/db/repos/apiKeysRepo.js");
    const keys = await getApiKeys();
    const legacyKey = keys.find(k => k.userId === null);

    const { checkCredits } = await import("@/lib/billing/checkCredits.js");
    const result = await checkCredits(legacyKey.key);
    expect(result.allowed).toBe(true);
  });

  it("user with balance > 0 → allowed", async () => {
    const { key } = await seedUserKey("good@example.com", 5.0);
    const { checkCredits } = await import("@/lib/billing/checkCredits.js");
    const result = await checkCredits(key.key);
    expect(result.allowed).toBe(true);
  });

  it("user with balance = 0 → not allowed, reason=insufficient credits", async () => {
    const { key } = await seedUserKey("zero@example.com", 0);
    const { checkCredits } = await import("@/lib/billing/checkCredits.js");
    const result = await checkCredits(key.key);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("insufficient credits");
  });

  it("user with balance < 0 (overshoot) → not allowed", async () => {
    const { key } = await seedUserKey("negative@example.com", -0.001);
    const { checkCredits } = await import("@/lib/billing/checkCredits.js");
    const result = await checkCredits(key.key);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("insufficient credits");
  });

  it("user isActive=false → not allowed, reason=account disabled", async () => {
    const { key } = await seedUserKey("disabled@example.com", 10.0, false);
    const { checkCredits } = await import("@/lib/billing/checkCredits.js");
    const result = await checkCredits(key.key);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("account disabled");
  });

  it("DB exception → allowed (fail-open)", async () => {
    // Mock getApiKeyByKey to throw
    vi.doMock("@/lib/db/repos/apiKeysRepo.js", () => ({
      getApiKeyByKey: vi.fn(() => { throw new Error("DB crashed"); }),
    }));

    const { checkCredits } = await import("@/lib/billing/checkCredits.js");
    const result = await checkCredits("some-key");
    expect(result.allowed).toBe(true);
  });
});
