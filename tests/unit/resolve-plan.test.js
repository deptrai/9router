import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-resolvePlan-"));
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

async function makeUserWithPlan(opts = {}) {
  const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
  const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
  const plan = await createPlan({
    name: opts.planName ?? "test-plan",
    rpm: opts.rpm ?? 20,
    quota5h: opts.quota5h ?? 1000000,
    quotaWeekly: opts.quotaWeekly ?? 10000000,
    perModelLimits: opts.perModelLimits ?? null,
    isActive: opts.planActive !== false,
  });
  const user = await createUser(opts.email ?? "u@test.dev", "hash", "Test");
  await updateUser(user.id, {
    planId: plan.id,
    planExpiresAt: opts.planExpiresAt !== undefined ? opts.planExpiresAt : null,
  });
  return { user, plan };
}

describe("resolveUserLimits", () => {
  it("user with active plan (no expiry) → source=plan with correct rpm/quota", async () => {
    const { makeUserWithPlan: _ } = { makeUserWithPlan };
    const { user, plan } = await makeUserWithPlan({ rpm: 15, quota5h: 500000, quotaWeekly: 5000000 });
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    const result = await resolveUserLimits(user.id);
    expect(result.source).toBe("plan");
    expect(result.planId).toBe(plan.id);
    expect(result.planName).toBe("test-plan");
    expect(result.rpm).toBe(15);
    expect(result.quota5h).toBe(500000);
    expect(result.quotaWeekly).toBe(5000000);
  });

  it("user with planExpiresAt in the past → source=credit, expired=true", async () => {
    const past = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    const { user } = await makeUserWithPlan({ planExpiresAt: past });
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    const result = await resolveUserLimits(user.id);
    expect(result.source).toBe("credit");
    expect(result.expired).toBe(true);
  });

  it("user with planExpiresAt in the future → source=plan", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    const { user } = await makeUserWithPlan({ planExpiresAt: future });
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    const result = await resolveUserLimits(user.id);
    expect(result.source).toBe("plan");
  });

  it("user with no planId → source=credit", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const user = await createUser("noplan@test.dev", "hash", "No Plan");
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    const result = await resolveUserLimits(user.id);
    expect(result.source).toBe("credit");
    expect(result.expired).toBeUndefined();
  });

  it("user with inactive plan → source=credit", async () => {
    const { user } = await makeUserWithPlan({ planActive: false });
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    const result = await resolveUserLimits(user.id);
    expect(result.source).toBe("credit");
  });

  it("per-model override returns modelLimit for matching model", async () => {
    const perModelLimits = { "claude-opus-4-8": { q5h: 50000, qWeekly: 200000 } };
    const { user } = await makeUserWithPlan({ quota5h: 1000000, quotaWeekly: 10000000, perModelLimits });
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    const result = await resolveUserLimits(user.id, "claude-opus-4-8");
    expect(result.source).toBe("plan");
    expect(result.modelLimit).toEqual({ quota5h: 50000, quotaWeekly: 200000 });
  });

  it("per-model override: model not in perModelLimits → modelLimit=null", async () => {
    const perModelLimits = { "claude-opus-4-8": { q5h: 50000, qWeekly: 200000 } };
    const { user } = await makeUserWithPlan({ perModelLimits });
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    const result = await resolveUserLimits(user.id, "claude-sonnet-4-6");
    expect(result.source).toBe("plan");
    expect(result.modelLimit).toBeNull();
  });

  it("update plan rpm then resolve again returns new value (AC#7 — no snapshot)", async () => {
    const { user, plan } = await makeUserWithPlan({ rpm: 10 });
    const { updatePlan } = await import("@/lib/db/repos/plansRepo.js");
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    await updatePlan(plan.id, { rpm: 50 });
    const result = await resolveUserLimits(user.id);
    expect(result.source).toBe("plan");
    expect(result.rpm).toBe(50);
  });

  it("fail-open: non-existent userId → source=credit (no throw)", async () => {
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    const result = await resolveUserLimits("ghost-user-id");
    expect(result.source).toBe("credit");
  });

  it("fail-open: error thrown inside resolve (getPlanById throws) → source=credit (no throw)", async () => {
    const { user } = await makeUserWithPlan({ rpm: 20 });
    // Force the plan lookup to throw to exercise the try/catch fail-open path
    // (distinct from the null-user early return above).
    vi.doMock("@/lib/db/repos/plansRepo.js", () => ({
      getPlanById: vi.fn(async () => {
        throw new Error("simulated DB failure");
      }),
    }));
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    const result = await resolveUserLimits(user.id);
    expect(result.source).toBe("credit");
    vi.doUnmock("@/lib/db/repos/plansRepo.js");
  });

  it("malformed planExpiresAt → treated as expired, source=credit (no silent grant)", async () => {
    const { user } = await makeUserWithPlan({ planExpiresAt: "not-a-real-date" });
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");
    const result = await resolveUserLimits(user.id);
    expect(result.source).toBe("credit");
    expect(result.expired).toBe(true);
  });
});
