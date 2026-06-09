import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planStatus-"));
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

describe("getPlanQuotaStatus", () => {
  it("is read-only and keeps quota state unchanged", async () => {
    const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { setPlanQuotaState, getPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    const { getPlanQuotaStatus } = await import("@/lib/quota/planQuotaStatus.js");

    const plan = await createPlan({ name: "gold-1", quota5h: 10, quotaWeekly: 100, rpm: 5 });
    const user = await createUser("status@test.dev", await bcrypt.hash("pass1234", 10), "Status");
    await updateUser(user.id, { planId: plan.id });
    const key = await createApiKey("status-key", "m1", user.id);

    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await setPlanQuotaState(user.id, { win5h: { startedAt }, winWeek: { startedAt } });

    const db = await getAdapter();
    db.run(`INSERT INTO usageHistory(timestamp,provider,model,connectionId,apiKey,endpoint,promptTokens,completionTokens,cost,status)
            VALUES(?,?,?,?,?,?,?,?,0,'done')`, [new Date(Date.now() - 30_000).toISOString(), "p", "m1", "c", key.key, "/v1/chat", 3, 2]);

    const before = await getPlanQuotaState(user.id);
    const first = await getPlanQuotaStatus(user.id);
    const after = await getPlanQuotaState(user.id);
    const second = await getPlanQuotaStatus(user.id);

    expect(after).toEqual(before);
    expect(second).toEqual(first);
    expect(first.source).toBe("plan");
    expect(first.quota5h.limit).toBe(10);
    expect(first.quota5h.consumed).toBe(5);
    expect(first.quotaWeekly.consumed).toBe(5);
  });

  it("treats quota=0 as unlimited and credit users as pay-as-you-go", async () => {
    const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
    const { getPlanQuotaStatus } = await import("@/lib/quota/planQuotaStatus.js");

    const freePlan = await createPlan({ name: "free-1", quota5h: 0, quotaWeekly: 0, rpm: 0 });
    const planUser = await createUser("free@test.dev", "hash", "Free");
    await updateUser(planUser.id, { planId: freePlan.id });
    const planStatus = await getPlanQuotaStatus(planUser.id);
    expect(planStatus.quota5h.limit).toBe(0);
    expect(planStatus.quotaWeekly.limit).toBe(0);

    const creditUser = await createUser("credit@test.dev", "hash", "Credit");
    const creditStatus = await getPlanQuotaStatus(creditUser.id);
    expect(creditStatus.source).toBe("credit");
    expect(creditStatus.planName).toBeUndefined();
    expect(creditStatus.creditsBalance).toBe(0);
  });

  it("exposes per-model status when requested model has an override", async () => {
    const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { setPlanQuotaState } = await import("@/lib/db/repos/quotaRepo.js");
    const { getPlanQuotaStatus } = await import("@/lib/quota/planQuotaStatus.js");

    const plan = await createPlan({ name: "model-status", quota5h: 1000, quotaWeekly: 2000, rpm: 5, perModelLimits: { "gpt-4o": { q5h: 100, qWeekly: 300 } } });
    const user = await createUser("model-status@test.dev", await bcrypt.hash("pass1234", 10), "Model Status");
    await updateUser(user.id, { planId: plan.id });
    const key = await createApiKey("model-status-key", "m1", user.id);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await setPlanQuotaState(user.id, { win5h: { startedAt }, winWeek: { startedAt } });

    const db = await getAdapter();
    db.run(`INSERT INTO usageHistory(timestamp,provider,model,connectionId,apiKey,endpoint,promptTokens,completionTokens,cost,status)
            VALUES(?,?,?,?,?,?,?,?,0,'done')`, [new Date(Date.now() - 30_000).toISOString(), "p", "gpt-4o", "c", key.key, "/v1/chat", 3, 2]);

    const status = await getPlanQuotaStatus(user.id, Date.now(), "gpt-4o");
    expect(status.model).toBe("gpt-4o");
    expect(status.perModelLimitsEnforced).toBe(true);
    expect(status.perModel.quota5h.limit).toBe(100);
    expect(status.perModel.quota5h.consumed).toBe(5);
    expect(status.perModel.quotaWeekly.limit).toBe(300);
  });

  it("returns perModel=null when requested model has no matching override", async () => {
    const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
    const { getPlanQuotaStatus } = await import("@/lib/quota/planQuotaStatus.js");
    const plan = await createPlan({ name: "no-model-status", quota5h: 1000, quotaWeekly: 2000, perModelLimits: { "gpt-4o": { q5h: 100, qWeekly: 300 } } });
    const user = await createUser("no-model-status@test.dev", "hash", "No Model Status");
    await updateUser(user.id, { planId: plan.id });
    const status = await getPlanQuotaStatus(user.id, Date.now(), "claude-sonnet");
    expect(status.model).toBe("claude-sonnet");
    expect(status.perModelLimitsEnforced).toBe(false);
    expect(status.perModel).toBeNull();
  });

  it("fails soft on resolver errors", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { getPlanQuotaStatus } = await import("@/lib/quota/planQuotaStatus.js");
    const mod = await import("@/lib/quota/resolvePlan.js");
    const user = await createUser("err@test.dev", "hash", "Err");
    vi.spyOn(mod, "resolveUserLimits").mockRejectedValueOnce(new Error("boom"));
    const result = await getPlanQuotaStatus(user.id);
    expect(result.source).toBe("error");
  });
});
