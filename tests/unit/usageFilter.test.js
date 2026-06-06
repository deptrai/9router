// Story 2.5 Task 1: getUsageStats userId filter (AC1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usageFilter-"));
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

// Seed 2 users each with their own key, insert usageHistory + usageDaily entries
async function seedScenario() {
  const bcrypt = await import("bcryptjs");
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  const { getAdapter } = await import("@/lib/db/driver.js");

  const hash = await bcrypt.default.hash("pass", 4);
  const userA = await createUser("userA@test.com", hash, "User A");
  const userB = await createUser("userB@test.com", hash, "User B");

  const keyA = await createApiKey("keyA", "machine-1", userA.id);
  const keyB = await createApiKey("keyB", "machine-2", userB.id);

  const db = await getAdapter();

  // Helper: insert usageHistory row
  const insHistory = (key, model, provider, cost, promptTokens, completionTokens) => {
    const ts = new Date().toISOString();
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ts, provider, model, null, key, "/v1/chat/completions", promptTokens, completionTokens, cost, "ok", "{}", "{}"]
    );
    return { key, model, provider, cost, promptTokens, completionTokens, ts };
  };

  // Insert usageDaily with byApiKey aggregated data
  const today = new Date();
  const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const dayData = {
    requests: 3,
    promptTokens: 300,
    completionTokens: 30,
    cost: 0.003,
    byProvider: {
      openai: { requests: 2, promptTokens: 200, completionTokens: 20, cost: 0.002 },
      anthropic: { requests: 1, promptTokens: 100, completionTokens: 10, cost: 0.001 },
    },
    byModel: {
      "gpt-4|openai": { requests: 2, promptTokens: 200, completionTokens: 20, cost: 0.002, rawModel: "gpt-4", provider: "openai" },
      "claude-3|anthropic": { requests: 1, promptTokens: 100, completionTokens: 10, cost: 0.001, rawModel: "claude-3", provider: "anthropic" },
    },
    byAccount: {},
    byApiKey: {
      [`${keyA.key}|gpt-4|openai`]: { requests: 2, promptTokens: 200, completionTokens: 20, cost: 0.002, rawModel: "gpt-4", provider: "openai", apiKey: keyA.key },
      [`${keyB.key}|claude-3|anthropic`]: { requests: 1, promptTokens: 100, completionTokens: 10, cost: 0.001, rawModel: "claude-3", provider: "anthropic", apiKey: keyB.key },
    },
    byEndpoint: {},
  };

  db.run(
    `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
    [dateKey, JSON.stringify(dayData)]
  );

  // Also insert usageHistory for 24h/today tests
  insHistory(keyA.key, "gpt-4", "openai", 0.001, 100, 10);
  insHistory(keyA.key, "gpt-4", "openai", 0.001, 100, 10);
  insHistory(keyB.key, "claude-3", "anthropic", 0.001, 100, 10);

  return { userA, userB, keyA, keyB, dateKey };
}

describe("getUsageStats — userId filter (AC1)", () => {
  it("userId=null (admin) → returns all keys data (backward-compat)", async () => {
    await seedScenario();
    const { getUsageStats } = await import("@/lib/db/repos/usageRepo.js");

    const stats = await getUsageStats("7d", null);
    expect(stats.totalCost).toBeGreaterThan(0);
    // Both users' data in byApiKey
    const akKeys = Object.keys(stats.byApiKey);
    expect(akKeys.length).toBeGreaterThanOrEqual(2);
  });

  it("no userId arg (old signature) → same as admin (backward-compat)", async () => {
    await seedScenario();
    const { getUsageStats } = await import("@/lib/db/repos/usageRepo.js");

    const statsOld = await getUsageStats("7d");
    const statsNew = await getUsageStats("7d", null);
    expect(statsOld.totalCost).toBe(statsNew.totalCost);
  });

  it("userId=userA → only sees userA key entries (7d path)", async () => {
    const { userA, keyA, keyB } = await seedScenario();
    const { getUsageStats } = await import("@/lib/db/repos/usageRepo.js");

    const stats = await getUsageStats("7d", userA.id);
    // byApiKey only contains keyA entries
    for (const entry of Object.values(stats.byApiKey)) {
      expect(entry.apiKey).toBe(keyA.key);
    }
    // No keyB entries
    const hasKeyB = Object.values(stats.byApiKey).some(e => e.apiKey === keyB.key);
    expect(hasKeyB).toBe(false);
    // Cost matches only keyA (0.002)
    expect(stats.totalCost).toBeCloseTo(0.002, 5);
  });

  it("userId=userB → only sees userB key entries (7d path)", async () => {
    const { userB, keyA, keyB } = await seedScenario();
    const { getUsageStats } = await import("@/lib/db/repos/usageRepo.js");

    const stats = await getUsageStats("7d", userB.id);
    for (const entry of Object.values(stats.byApiKey)) {
      expect(entry.apiKey).toBe(keyB.key);
    }
    const hasKeyA = Object.values(stats.byApiKey).some(e => e.apiKey === keyA.key);
    expect(hasKeyA).toBe(false);
    expect(stats.totalCost).toBeCloseTo(0.001, 5);
  });

  it("userId=userA → only sees userA key entries (24h path)", async () => {
    const { userA, keyA, keyB } = await seedScenario();
    const { getUsageStats } = await import("@/lib/db/repos/usageRepo.js");

    const stats = await getUsageStats("24h", userA.id);
    for (const akKey of Object.keys(stats.byApiKey)) {
      if (akKey !== "local-no-key") {
        const entry = stats.byApiKey[akKey];
        expect(entry.apiKey).toBe(keyA.key);
      }
    }
    const hasKeyB = Object.values(stats.byApiKey).some(e => e.apiKey === keyB.key);
    expect(hasKeyB).toBe(false);
  });

  it("user with no keys → empty stats", async () => {
    const bcrypt = await import("bcryptjs");
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const hash = await bcrypt.default.hash("pass", 4);
    const userC = await createUser("userC@test.com", hash, "User C");
    // No keys, no usage
    const { getUsageStats } = await import("@/lib/db/repos/usageRepo.js");
    const stats = await getUsageStats("7d", userC.id);
    expect(stats.totalCost).toBe(0);
    expect(Object.keys(stats.byApiKey).length).toBe(0);
  });
});
