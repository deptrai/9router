/**
 * users-me-overflow.test.js — allowCreditOverflow toggle (Story 2.14, AC#1, #8)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-overflow-"));
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

describe("allowCreditOverflow — schema + usersRepo (AC#1)", () => {
  it("default allowCreditOverflow is false", async () => {
    const { createUser, getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const user = await createUser("default@test.dev", "hash", "Default");
    const fetched = await getUserById(user.id);
    expect(fetched.allowCreditOverflow).toBe(false);
  });

  it("updateUser can set allowCreditOverflow to true", async () => {
    const { createUser, updateUser, getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const user = await createUser("toggle@test.dev", "hash", "Toggle");
    await updateUser(user.id, { allowCreditOverflow: true });
    const fetched = await getUserById(user.id);
    expect(fetched.allowCreditOverflow).toBe(true);
  });

  it("updateUser can toggle back to false", async () => {
    const { createUser, updateUser, getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const user = await createUser("toggleback@test.dev", "hash", "ToggleBack");
    await updateUser(user.id, { allowCreditOverflow: true });
    await updateUser(user.id, { allowCreditOverflow: false });
    const fetched = await getUserById(user.id);
    expect(fetched.allowCreditOverflow).toBe(false);
  });

  it("updateUser preserves other fields when toggling overflow", async () => {
    const { createUser, updateUser, getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const user = await createUser("nooverwrite@test.dev", "hash", "NoOverwrite");
    await updateUser(user.id, { creditsBalance: 42 });
    await updateUser(user.id, { allowCreditOverflow: true });
    const fetched = await getUserById(user.id);
    expect(fetched.creditsBalance).toBe(42);
    expect(fetched.allowCreditOverflow).toBe(true);
  });

  it("allowCreditOverflow is included in rowToUser (exposed in getUserById)", async () => {
    const { createUser, getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const user = await createUser("exposed@test.dev", "hash", "Exposed");
    const fetched = await getUserById(user.id);
    expect("allowCreditOverflow" in fetched).toBe(true);
  });
});

describe("allowCreditOverflow — migration 004 (AC#1)", () => {
  it("creditTransactions does NOT have allowCreditOverflow (different table)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const userCols = db.all(`PRAGMA table_info(users)`).map(r => r.name);
    expect(userCols).toContain("allowCreditOverflow");
  });

  it("default value is 0 (OFF) at DB level", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const user = await createUser("dbdefault@test.dev", "hash", "DBDefault");
    const db = await getAdapter();
    const row = db.get(`SELECT allowCreditOverflow FROM users WHERE id = ?`, [user.id]);
    expect(row.allowCreditOverflow).toBe(0);
  });
});

describe("checkPlanQuota returns allowCreditOverflow from user record (AC#2-4)", () => {
  it("exhausted plan: allowCreditOverflow reflects user setting", async () => {
    const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");

    const plan = await createPlan({ name: "overflow-plan", quota5h: 10, quotaWeekly: 0 });
    const user = await createUser("ov@test.dev", "hash", "OV");
    await updateUser(user.id, { planId: plan.id, allowCreditOverflow: true });
    const key = await createApiKey("ov-key", "m1", user.id);

    // Pre-seed window state 2 minutes ago so usage row falls inside
    const twoMinAgo = Date.now() - 120_000;
    await setPlanQuotaState(user.id, { win5h: { startedAt: new Date(twoMinAgo).toISOString() } });

    const db = await getAdapter();
    const pastTs = new Date(Date.now() - 60_000).toISOString();
    db.run(
      `INSERT INTO usageHistory(timestamp,provider,model,connectionId,apiKey,endpoint,promptTokens,completionTokens,cost,status)
       VALUES(?,?,?,?,?,?,?,?,0,'done')`,
      [pastTs, "test", "gpt-4o", "conn", key.key, "/v1/chat", 6, 5]
    );

    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key);
    expect(result.source).toBe("plan");
    expect(result.allowed).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.allowCreditOverflow).toBe(true); // user has it ON
  });
});
