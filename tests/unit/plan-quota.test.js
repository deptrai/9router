/**
 * plan-quota.test.js — checkPlanQuota (Story 2.14, E.3)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planquota-"));
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

async function setupUserWithPlan({ rpm = 20, quota5h = 1000000, quotaWeekly = 10000000, allowCreditOverflow = false, perModelLimits = null } = {}) {
  const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
  const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
  const plan = await createPlan({ name: "test-plan", rpm, quota5h, quotaWeekly, perModelLimits });
  const user = await createUser("quota@test.dev", "hash", "Quota User");
  await updateUser(user.id, { planId: plan.id, allowCreditOverflow });
  const key = await createApiKey("quota-key", "machine-1", user.id);
  return { user, plan, key };
}

async function insertUsage({ apiKey, model = "gpt-4o", promptTokens = 60, completionTokens = 50, ageMs = 60_000 }) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  db.run(
    `INSERT INTO usageHistory(timestamp,provider,model,connectionId,apiKey,endpoint,promptTokens,completionTokens,cost,status)
     VALUES(?,?,?,?,?,?,?,?,0,'done')`,
    [new Date(Date.now() - ageMs).toISOString(), "test", model, "conn", apiKey, "/v1/chat", promptTokens, completionTokens]
  );
}

describe("checkPlanQuota", () => {
  it("no apiKey → source=none allowed", async () => {
    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    expect((await checkPlanQuota(null)).source).toBe("none");
    expect((await checkPlanQuota(null)).allowed).toBe(true);
    expect((await checkPlanQuota("")).allowed).toBe(true);
  });

  it("legacy key (no userId) → source=none allowed", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const k = await createApiKey("legacy", "m1"); // no userId
    expect((await checkPlanQuota(k.key)).source).toBe("none");
    expect((await checkPlanQuota(k.key)).allowed).toBe(true);
  });

  it("user with no plan (source=credit) → allowed", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const user = await createUser("noplan@test.dev", "hash", "NoPlan");
    const key = await createApiKey("noplan-key", "m1", user.id);
    const result = await checkPlanQuota(key.key);
    expect(result.source).toBe("credit");
    expect(result.allowed).toBe(true);
  });

  it("plan with quota=0 (unlimited) → allowed", async () => {
    const { key } = await setupUserWithPlan({ quota5h: 0, quotaWeekly: 0 });
    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key);
    expect(result.source).toBe("plan");
    expect(result.allowed).toBe(true);
  });

  it("plan within quota → allowed, returns planName + allowCreditOverflow", async () => {
    const { key } = await setupUserWithPlan({ quota5h: 1000000 });
    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key);
    expect(result.source).toBe("plan");
    expect(result.allowed).toBe(true);
    expect(result.planName).toBe("test-plan");
    expect(typeof result.allowCreditOverflow).toBe("boolean");
  });

  it("plan 5h quota exhausted → allowed=false, window=5h", async () => {
    const { user, key } = await setupUserWithPlan({ quota5h: 100, quotaWeekly: 1000000 });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    // Insert usage 1 minute AGO so it falls within a window starting now
    const pastTs = new Date(Date.now() - 60_000).toISOString();
    db.run(
      `INSERT INTO usageHistory(timestamp,provider,model,connectionId,apiKey,endpoint,promptTokens,completionTokens,cost,status)
       VALUES(?,?,?,?,?,?,?,?,0,'done')`,
      [pastTs, "test", "gpt-4o", "conn", key.key, "/v1/chat", 60, 50]
    );
    // First call initializes window with startedAt = 2 minutes ago so usage row is inside
    const twoMinAgo = Date.now() - 120_000;
    const { getPlanQuotaState, setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    await setPlanQuotaState(user.id, { win5h: { startedAt: new Date(twoMinAgo).toISOString() }, winWeek: { startedAt: new Date(twoMinAgo).toISOString() } });

    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key, null, Date.now());
    expect(result.source).toBe("plan");
    expect(result.allowed).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.window).toBe("5h");
    expect(result.consumed).toBeGreaterThanOrEqual(100);
    expect(result.retryAfter).toBeTruthy();
    expect(result.retryAfterHuman).toBeTruthy();
    expect(typeof result.allowCreditOverflow).toBe("boolean");
  });

  it("plan weekly quota exhausted → window=weekly", async () => {
    const { user, key } = await setupUserWithPlan({ quota5h: 0, quotaWeekly: 50 });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    const db = await getAdapter();
    const twoMinAgo = Date.now() - 120_000;
    await setPlanQuotaState(user.id, { winWeek: { startedAt: new Date(twoMinAgo).toISOString() } });
    const pastTs = new Date(Date.now() - 60_000).toISOString();
    db.run(
      `INSERT INTO usageHistory(timestamp,provider,model,connectionId,apiKey,endpoint,promptTokens,completionTokens,cost,status)
       VALUES(?,?,?,?,?,?,?,?,0,'done')`,
      [pastTs, "test", "gpt-4o", "conn", key.key, "/v1/chat", 30, 25]
    );
    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key, null, Date.now());
    expect(result.source).toBe("plan");
    expect(result.allowed).toBe(false);
    expect(result.window).toBe("weekly");
  });

  it("matching model below total and per-model quotas → allowed", async () => {
    const { user, key } = await setupUserWithPlan({
      quota5h: 1000,
      quotaWeekly: 2000,
      perModelLimits: { "gpt-4o": { q5h: 200, qWeekly: 300 } },
    });
    const { setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    const twoMinAgo = Date.now() - 120_000;
    await setPlanQuotaState(user.id, { win5h: { startedAt: new Date(twoMinAgo).toISOString() }, winWeek: { startedAt: new Date(twoMinAgo).toISOString() } });
    await insertUsage({ apiKey: key.key, model: "gpt-4o", promptTokens: 40, completionTokens: 30 });

    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key, "gpt-4o", Date.now());
    expect(result.source).toBe("plan");
    expect(result.allowed).toBe(true);
  });

  it("matching model total remains but per-model 5h exhausted → blocked with model scope", async () => {
    const { user, key } = await setupUserWithPlan({
      quota5h: 1000,
      quotaWeekly: 2000,
      perModelLimits: { "gpt-4o": { q5h: 100, qWeekly: 1000 } },
    });
    const { setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    const twoMinAgo = Date.now() - 120_000;
    await setPlanQuotaState(user.id, { win5h: { startedAt: new Date(twoMinAgo).toISOString() }, winWeek: { startedAt: new Date(twoMinAgo).toISOString() } });
    await insertUsage({ apiKey: key.key, model: "gpt-4o", promptTokens: 60, completionTokens: 50 });

    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key, "gpt-4o", Date.now());
    expect(result.allowed).toBe(false);
    expect(result.window).toBe("5h");
    expect(result.scope).toBe("model");
    expect(result.model).toBe("gpt-4o");
    expect(result.limit).toBe(100);
  });

  it("matching model total remains but per-model weekly exhausted → blocked with model scope", async () => {
    const { user, key } = await setupUserWithPlan({
      quota5h: 0,
      quotaWeekly: 1000,
      perModelLimits: { "gpt-4o": { q5h: 0, qWeekly: 100 } },
    });
    const { setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    const twoMinAgo = Date.now() - 120_000;
    await setPlanQuotaState(user.id, { winWeek: { startedAt: new Date(twoMinAgo).toISOString() } });
    await insertUsage({ apiKey: key.key, model: "gpt-4o", promptTokens: 60, completionTokens: 50 });

    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key, "gpt-4o", Date.now());
    expect(result.allowed).toBe(false);
    expect(result.window).toBe("weekly");
    expect(result.scope).toBe("model");
  });

  it("total exhausted before per-model → total scope wins", async () => {
    const { user, key } = await setupUserWithPlan({
      quota5h: 100,
      quotaWeekly: 1000,
      perModelLimits: { "gpt-4o": { q5h: 500, qWeekly: 800 } },
    });
    const { setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    const twoMinAgo = Date.now() - 120_000;
    await setPlanQuotaState(user.id, { win5h: { startedAt: new Date(twoMinAgo).toISOString() }, winWeek: { startedAt: new Date(twoMinAgo).toISOString() } });
    await insertUsage({ apiKey: key.key, model: "gpt-4o", promptTokens: 60, completionTokens: 50 });

    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key, "gpt-4o", Date.now());
    expect(result.allowed).toBe(false);
    expect(result.window).toBe("5h");
    expect(result.scope ?? "total").toBe("total");
    expect(result.limit).toBe(100);
  });

  it("non-matching model override → total-only behavior remains", async () => {
    const { user, key } = await setupUserWithPlan({
      quota5h: 1000,
      quotaWeekly: 2000,
      perModelLimits: { "gpt-4o": { q5h: 100, qWeekly: 100 } },
    });
    const { setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    const twoMinAgo = Date.now() - 120_000;
    await setPlanQuotaState(user.id, { win5h: { startedAt: new Date(twoMinAgo).toISOString() }, winWeek: { startedAt: new Date(twoMinAgo).toISOString() } });
    await insertUsage({ apiKey: key.key, model: "claude-sonnet", promptTokens: 60, completionTokens: 50 });

    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key, "claude-sonnet", Date.now());
    expect(result.allowed).toBe(true);
  });

  it("per-model zero window is unlimited but total quota still enforces", async () => {
    const { user, key } = await setupUserWithPlan({
      quota5h: 120,
      quotaWeekly: 2000,
      perModelLimits: { "gpt-4o": { q5h: 0, qWeekly: 0 } },
    });
    const { setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    const twoMinAgo = Date.now() - 120_000;
    await setPlanQuotaState(user.id, { win5h: { startedAt: new Date(twoMinAgo).toISOString() }, winWeek: { startedAt: new Date(twoMinAgo).toISOString() } });
    await insertUsage({ apiKey: key.key, model: "gpt-4o", promptTokens: 60, completionTokens: 50 });
    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    expect((await checkPlanQuota(key.key, "gpt-4o", Date.now())).allowed).toBe(true);
    await insertUsage({ apiKey: key.key, model: "gpt-4o", promptTokens: 20, completionTokens: 0, ageMs: 30_000 });
    const result = await checkPlanQuota(key.key, "gpt-4o", Date.now());
    expect(result.allowed).toBe(false);
    expect(result.scope ?? "total").toBe("total");
  });

  it("update plan quota → next check uses new value (AC#7)", async () => {
    const { user, key, plan } = await setupUserWithPlan({ quota5h: 100 });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { updatePlan } = await import("@/lib/db/repos/plansRepo.js");
    const { setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    const db = await getAdapter();
    const twoMinAgo = Date.now() - 120_000;
    await setPlanQuotaState(user.id, { win5h: { startedAt: new Date(twoMinAgo).toISOString() } });
    const pastTs = new Date(Date.now() - 60_000).toISOString();
    db.run(
      `INSERT INTO usageHistory(timestamp,provider,model,connectionId,apiKey,endpoint,promptTokens,completionTokens,cost,status)
       VALUES(?,?,?,?,?,?,?,?,0,'done')`,
      [pastTs, "test", "gpt-4o", "conn", key.key, "/v1/chat", 60, 50]
    );
    // With quota=100 → exhausted
    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const r1 = await checkPlanQuota(key.key);
    expect(r1.allowed).toBe(false);
    // Upgrade quota to 1M → now allowed
    await updatePlan(plan.id, { quota5h: 1000000 });
    const r2 = await checkPlanQuota(key.key);
    expect(r2.allowed).toBe(true);
  });

  it("fail-open: resolveUserLimits throws → source=error, allowed=true", async () => {
    const { key } = await setupUserWithPlan();
    vi.doMock("@/lib/quota/resolvePlan.js", () => ({
      resolveUserLimits: vi.fn(async () => { throw new Error("resolver error"); }),
    }));
    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key);
    expect(result.source).toBe("error");
    expect(result.allowed).toBe(true);
    vi.doUnmock("@/lib/quota/resolvePlan.js");
  });

  it("fail-open: sumUsageTokensByUser throws → source=error, allowed=true", async () => {
    const { key } = await setupUserWithPlan({ quota5h: 100 });
    vi.doMock("@/lib/db/repos/quotaRepo.js", async () => {
      const actual = await vi.importActual("@/lib/db/repos/quotaRepo.js");
      return { ...actual, sumUsageTokensByUser: vi.fn(async () => { throw new Error("db error"); }) };
    });
    const { checkPlanQuota } = await import("@/lib/quota/planQuota.js");
    const result = await checkPlanQuota(key.key);
    expect(result.source).toBe("error");
    expect(result.allowed).toBe(true);
    vi.doUnmock("@/lib/db/repos/quotaRepo.js");
  });
});
