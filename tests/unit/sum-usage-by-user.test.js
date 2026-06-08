import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sumUsageByUser-"));
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

async function seedUsageRow(db, { apiKey, model, promptTokens, completionTokens, timestamp }) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status)
     VALUES(?, 'test', ?, 'conn-1', ?, '/v1/chat/completions', ?, ?, 0, 'done')`,
    [timestamp, model, apiKey, promptTokens, completionTokens]
  );
}

describe("sumUsageTokensByUser", () => {
  it("sums tokens across multiple keys for same userId", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { sumUsageTokensByUser } = await import("@/lib/db/repos/quotaRepo.js");

    const user = await createUser("multi@test.dev", "hash", "Multi");
    const k1 = await createApiKey("key-1", "m1", user.id);
    const k2 = await createApiKey("key-2", "m1", user.id);

    const db = await getAdapter();
    const since = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    await seedUsageRow(db, { apiKey: k1.key, model: "gpt-4o", promptTokens: 100, completionTokens: 50, timestamp: new Date().toISOString() });
    await seedUsageRow(db, { apiKey: k2.key, model: "gpt-4o", promptTokens: 200, completionTokens: 100, timestamp: new Date().toISOString() });

    const total = await sumUsageTokensByUser(user.id, null, since);
    expect(total).toBe(450);
  });

  it("does not count tokens from other users' keys", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { sumUsageTokensByUser } = await import("@/lib/db/repos/quotaRepo.js");

    const userA = await createUser("userA@test.dev", "hash", "A");
    const userB = await createUser("userB@test.dev", "hash", "B");
    const kA = await createApiKey("key-A", "m1", userA.id);
    const kB = await createApiKey("key-B", "m1", userB.id);

    const db = await getAdapter();
    const since = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    await seedUsageRow(db, { apiKey: kA.key, model: "gpt-4o", promptTokens: 300, completionTokens: 100, timestamp: new Date().toISOString() });
    await seedUsageRow(db, { apiKey: kB.key, model: "gpt-4o", promptTokens: 999, completionTokens: 999, timestamp: new Date().toISOString() });

    const total = await sumUsageTokensByUser(userA.id, null, since);
    expect(total).toBe(400);
  });

  it("filters by model (exact match)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { sumUsageTokensByUser } = await import("@/lib/db/repos/quotaRepo.js");

    const user = await createUser("model@test.dev", "hash", "Model");
    const k = await createApiKey("key-model", "m1", user.id);

    const db = await getAdapter();
    const since = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    await seedUsageRow(db, { apiKey: k.key, model: "gpt-4o", promptTokens: 100, completionTokens: 50, timestamp: new Date().toISOString() });
    await seedUsageRow(db, { apiKey: k.key, model: "claude-sonnet-4-6", promptTokens: 200, completionTokens: 100, timestamp: new Date().toISOString() });

    const gptTotal = await sumUsageTokensByUser(user.id, "gpt-4o", since);
    expect(gptTotal).toBe(150);

    const claudeTotal = await sumUsageTokensByUser(user.id, "claude-sonnet-4-6", since);
    expect(claudeTotal).toBe(300);
  });

  it("normalized model match (dot vs dash variant)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { sumUsageTokensByUser } = await import("@/lib/db/repos/quotaRepo.js");

    const user = await createUser("norm@test.dev", "hash", "Norm");
    const k = await createApiKey("key-norm", "m1", user.id);

    const db = await getAdapter();
    const since = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    // Store as dot variant (as Kiro might log it)
    await seedUsageRow(db, { apiKey: k.key, model: "claude-opus-4.8", promptTokens: 100, completionTokens: 50, timestamp: new Date().toISOString() });

    // Query with dash variant — should still match via normalize
    const total = await sumUsageTokensByUser(user.id, "claude-opus-4-8", since);
    expect(total).toBe(150);
  });

  it("respects sinceISO time boundary", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { sumUsageTokensByUser } = await import("@/lib/db/repos/quotaRepo.js");

    const user = await createUser("time@test.dev", "hash", "Time");
    const k = await createApiKey("key-time", "m1", user.id);

    const db = await getAdapter();
    const oldTs = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // 24h ago
    const newTs = new Date().toISOString();
    const since = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1h ago

    await seedUsageRow(db, { apiKey: k.key, model: "gpt-4o", promptTokens: 999, completionTokens: 999, timestamp: oldTs });
    await seedUsageRow(db, { apiKey: k.key, model: "gpt-4o", promptTokens: 100, completionTokens: 50, timestamp: newTs });

    const total = await sumUsageTokensByUser(user.id, null, since);
    expect(total).toBe(150); // only the recent row
  });

  it("returns 0 when no usage rows exist for user", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { sumUsageTokensByUser } = await import("@/lib/db/repos/quotaRepo.js");

    const user = await createUser("empty@test.dev", "hash", "Empty");
    const since = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    const total = await sumUsageTokensByUser(user.id, null, since);
    expect(total).toBe(0);
  });
});
