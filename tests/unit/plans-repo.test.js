import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-plansRepo-"));
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

describe("plansRepo", () => {
  it("createPlan and getPlanById round-trip", async () => {
    const { createPlan, getPlanById } = await import("@/lib/db/repos/plansRepo.js");
    const plan = await createPlan({ name: "starter", displayName: "Starter", rpm: 5, quota5h: 100000, quotaWeekly: 500000 });
    expect(plan.id).toBeTruthy();
    expect(plan.name).toBe("starter");
    expect(plan.rpm).toBe(5);
    const fetched = await getPlanById(plan.id);
    expect(fetched.id).toBe(plan.id);
    expect(fetched.displayName).toBe("Starter");
  });

  it("getPlanByName returns correct plan", async () => {
    const { createPlan, getPlanByName } = await import("@/lib/db/repos/plansRepo.js");
    await createPlan({ name: "alpha", rpm: 10 });
    const plan = await getPlanByName("alpha");
    expect(plan.name).toBe("alpha");
  });

  it("getPlanByName returns null for unknown name", async () => {
    const { getPlanByName } = await import("@/lib/db/repos/plansRepo.js");
    expect(await getPlanByName("nonexistent")).toBeNull();
  });

  it("listPlans returns plans sorted by sortOrder", async () => {
    const { createPlan, listPlans } = await import("@/lib/db/repos/plansRepo.js");
    const p1 = await createPlan({ name: "b-plan", sortOrder: 100 });
    const p2 = await createPlan({ name: "a-plan", sortOrder: 99 });
    const plans = await listPlans();
    // migration seeds free(0)/pro(1)/max(2); our plans have sortOrder 99/100
    const ours = plans.filter(p => p.name === "a-plan" || p.name === "b-plan");
    expect(ours.length).toBe(2);
    expect(ours[0].name).toBe("a-plan");
    expect(ours[1].name).toBe("b-plan");
  });

  it("listPlans({ activeOnly: true }) excludes inactive plans", async () => {
    const { createPlan, listPlans, deletePlan } = await import("@/lib/db/repos/plansRepo.js");
    const p1 = await createPlan({ name: "active-plan", sortOrder: 100 });
    const p2 = await createPlan({ name: "inactive-plan", sortOrder: 101 });
    await deletePlan(p2.id); // soft delete
    const active = await listPlans({ activeOnly: true });
    const ours = active.filter(p => p.name === "active-plan" || p.name === "inactive-plan");
    expect(ours.length).toBe(1);
    expect(ours[0].id).toBe(p1.id);
  });

  it("updatePlan changes fields and updates updatedAt", async () => {
    const { createPlan, updatePlan, getPlanById } = await import("@/lib/db/repos/plansRepo.js");
    const plan = await createPlan({ name: "mutable", rpm: 10 });
    const before = plan.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    const updated = await updatePlan(plan.id, { rpm: 25, displayName: "Mutable Pro" });
    expect(updated.rpm).toBe(25);
    expect(updated.displayName).toBe("Mutable Pro");
    expect(updated.updatedAt).not.toBe(before);
  });

  it("updatePlan returns null for unknown id", async () => {
    const { updatePlan } = await import("@/lib/db/repos/plansRepo.js");
    expect(await updatePlan("ghost-id", { rpm: 5 })).toBeNull();
  });

  it("perModelLimits JSON round-trip", async () => {
    const { createPlan, getPlanById } = await import("@/lib/db/repos/plansRepo.js");
    const limits = { "claude-opus-4-8": { q5h: 50000, qWeekly: 200000 } };
    const plan = await createPlan({ name: "with-limits", perModelLimits: limits });
    const fetched = await getPlanById(plan.id);
    expect(fetched.perModelLimits).toEqual(limits);
  });

  it("deletePlan soft-delete sets isActive=0", async () => {
    const { createPlan, deletePlan, getPlanById } = await import("@/lib/db/repos/plansRepo.js");
    const plan = await createPlan({ name: "to-delete" });
    await deletePlan(plan.id);
    const fetched = await getPlanById(plan.id);
    expect(fetched.isActive).toBe(false);
  });

  it("deletePlan hard-delete removes plan when no users reference it", async () => {
    const { createPlan, deletePlan, getPlanById } = await import("@/lib/db/repos/plansRepo.js");
    const plan = await createPlan({ name: "hard-delete-me" });
    await deletePlan(plan.id, { hard: true });
    expect(await getPlanById(plan.id)).toBeNull();
  });

  it("deletePlan hard-delete throws when users reference the plan", async () => {
    const { createPlan, deletePlan } = await import("@/lib/db/repos/plansRepo.js");
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { updateUser } = await import("@/lib/db/repos/usersRepo.js");
    const plan = await createPlan({ name: "referenced-plan" });
    const user = await createUser("ref@test.dev", "hash", "Ref User");
    await updateUser(user.id, { planId: plan.id });
    await expect(deletePlan(plan.id, { hard: true })).rejects.toThrow();
  });

  it("exports are available from barrel (db/index.js)", async () => {
    const db = await import("@/lib/db/index.js");
    expect(typeof db.listPlans).toBe("function");
    expect(typeof db.getPlanById).toBe("function");
    expect(typeof db.getPlanByName).toBe("function");
    expect(typeof db.createPlan).toBe("function");
    expect(typeof db.updatePlan).toBe("function");
    expect(typeof db.deletePlan).toBe("function");
  });
});
