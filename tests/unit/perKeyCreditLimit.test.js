import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-perkey-"));
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

async function seedUser(email = "test@example.com", balance = 10) {
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
  const hash = await bcrypt.hash("pass12345", 4);
  const user = await createUser(email, hash, "Test");
  if (balance > 0) {
    await recordCreditTxn({ userId: user.id, type: "admin_topup", bucket: "standard", amount: balance, refId: `seed:${email}` }, null);
  }
  return user;
}

async function seedUsageHistory(apiKey, cost) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  db.run(
    `INSERT INTO usageHistory(timestamp, apiKey, cost, provider, model, status, tokens, meta)
     VALUES(?, ?, ?, 'test', 'test-model', 'ok', '{}', '{}')`,
    [new Date().toISOString(), apiKey, cost]
  );
}

// ─── A2: createApiKey + updateApiKey ─────────────────────────────────────────

describe("createApiKey — creditLimit", () => {
  it("stores creditLimit when provided", async () => {
    const user = await seedUser("a@test.com");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "machine-1", user.id, null, 5.0);
    expect(key.creditLimit).toBe(5.0);
  });

  it("creditLimit=null → unlimited", async () => {
    const user = await seedUser("b@test.com");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "machine-1", user.id, null, null);
    expect(key.creditLimit).toBeNull();
  });

  it("default creditLimit is null", async () => {
    const user = await seedUser("c@test.com");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "machine-1", user.id);
    expect(key.creditLimit).toBeNull();
  });
});

describe("updateApiKey — creditLimit", () => {
  it("can set creditLimit on existing key", async () => {
    const user = await seedUser("d@test.com");
    const { createApiKey, updateApiKey, getApiKeyByKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "machine-1", user.id);
    await updateApiKey(key.id, { creditLimit: 3.5 });
    const updated = await getApiKeyByKey(key.key);
    expect(updated.creditLimit).toBeCloseTo(3.5);
  });

  it("can clear creditLimit (set to null)", async () => {
    const user = await seedUser("e@test.com");
    const { createApiKey, updateApiKey, getApiKeyByKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "machine-1", user.id, null, 5.0);
    await updateApiKey(key.id, { creditLimit: null });
    const updated = await getApiKeyByKey(key.key);
    expect(updated.creditLimit).toBeNull();
  });
});

// ─── B1: checkCredits per-key limit ──────────────────────────────────────────

describe("checkPerKeyLimit — per-key credit limit", () => {
  it("key usage < limit → allowed", async () => {
    const user = await seedUser("f@test.com", 10);
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "machine-1", user.id, null, 5.0);
    await seedUsageHistory(key.key, 2.0); // $2 used out of $5 limit

    const { checkPerKeyLimit } = await import("@/lib/billing/checkCredits.js");
    const result = await checkPerKeyLimit(key.key);
    expect(result.allowed).toBe(true);
  });

  it("key usage >= limit → blocked with 'key credit limit reached'", async () => {
    const user = await seedUser("g@test.com", 10);
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "machine-1", user.id, null, 3.0);
    await seedUsageHistory(key.key, 3.5); // $3.5 used, exceeds $3 limit

    const { checkPerKeyLimit } = await import("@/lib/billing/checkCredits.js");
    const result = await checkPerKeyLimit(key.key);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("key credit limit reached");
  });

  it("key usage exactly at limit → blocked", async () => {
    const user = await seedUser("h@test.com", 10);
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "machine-1", user.id, null, 2.0);
    await seedUsageHistory(key.key, 2.0); // exactly at limit

    const { checkPerKeyLimit } = await import("@/lib/billing/checkCredits.js");
    const result = await checkPerKeyLimit(key.key);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("key credit limit reached");
  });

  it("creditLimit=null → no per-key block even with high usage", async () => {
    const user = await seedUser("i@test.com", 10);
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "machine-1", user.id, null, null);
    await seedUsageHistory(key.key, 999.0); // huge usage, but no limit

    const { checkPerKeyLimit } = await import("@/lib/billing/checkCredits.js");
    const result = await checkPerKeyLimit(key.key);
    expect(result.allowed).toBe(true);
  });

  it("legacy key (userId=null) → allowed regardless of usage", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("legacy-key", "machine-1", null, null, 1.0);
    await seedUsageHistory(key.key, 100.0);

    const { checkPerKeyLimit } = await import("@/lib/billing/checkCredits.js");
    const result = await checkPerKeyLimit(key.key);
    expect(result.allowed).toBe(true);
  });

  it("per-key and user balance are independent — key limit blocks even with balance", async () => {
    const user = await seedUser("j@test.com", 50); // high user balance
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "machine-1", user.id, null, 1.0);
    await seedUsageHistory(key.key, 2.0); // key exceeded, user balance fine

    const { checkPerKeyLimit } = await import("@/lib/billing/checkCredits.js");
    const result = await checkPerKeyLimit(key.key);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("key credit limit reached");
  });
});
