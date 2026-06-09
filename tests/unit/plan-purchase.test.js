import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planPurchase-"));
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
  vi.resetModules();
});

async function setupUser({ credits = 100, planId = null, planExpiresAt = null } = {}) {
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const user = await createUser(`plan-${crypto.randomUUID()}@test.dev`, await bcrypt.hash("pass1234", 10), "Plan User");
  const db = await getAdapter();
  db.run(`UPDATE users SET creditsBalance = ?, planId = ?, planExpiresAt = ? WHERE id = ?`, [credits, planId, planExpiresAt, user.id]);
  return { ...user, creditsBalance: credits, planId, planExpiresAt };
}

async function createPricedPlan(data) {
  const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
  return createPlan({ name: `p-${crypto.randomUUID().slice(0, 8)}`, priceCredits: 10, durationDays: 30, ...data });
}

describe("purchasePlanForUser", () => {
  it("buys a plan atomically: ledger row, user plan, balance", async () => {
    const user = await setupUser({ credits: 50 });
    const plan = await createPricedPlan({ priceCredits: 10, durationDays: 30 });
    const { purchasePlanForUser } = await import("@/lib/plans/planPurchase.js");

    const result = await purchasePlanForUser({ userId: user.id, planId: plan.id, idempotencyKey: "buy-1", now: Date.parse("2026-06-10T00:00:00Z") });

    expect(result.action).toBe("buy");
    expect(result.user.creditsBalance).toBe(40);
    expect(result.user.planId).toBe(plan.id);
    expect(result.user.planExpiresAt).toBe("2026-07-10T00:00:00.000Z");
    expect(result.transaction).toMatchObject({ type: "plan_activation", amount: -10, idempotencyKey: `plan_activation:${user.id}:buy-1` });
  });

  it("renews same active plan from future expiry without resetting quota state", async () => {
    const plan = await createPricedPlan({ priceCredits: 5, durationDays: 10 });
    const user = await setupUser({ credits: 20, planId: plan.id, planExpiresAt: "2026-06-20T00:00:00.000Z" });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO kv(scope, key, value) VALUES('planQuotaState', ?, ?)`, [user.id, JSON.stringify({ win5h: { startedAt: "x" } })]);
    const { purchasePlanForUser } = await import("@/lib/plans/planPurchase.js");

    const result = await purchasePlanForUser({ userId: user.id, planId: plan.id, idempotencyKey: "renew-1", now: Date.parse("2026-06-10T00:00:00Z") });

    expect(result.action).toBe("renew");
    expect(result.user.planExpiresAt).toBe("2026-06-30T00:00:00.000Z");
    expect(JSON.parse(db.get(`SELECT value FROM kv WHERE scope='planQuotaState' AND key=?`, [user.id]).value)).toEqual({ win5h: { startedAt: "x" } });
  });

  it("renews same active indefinite plan from now", async () => {
    const plan = await createPricedPlan({ priceCredits: 5, durationDays: 10 });
    const user = await setupUser({ credits: 20, planId: plan.id, planExpiresAt: null });
    const { purchasePlanForUser } = await import("@/lib/plans/planPurchase.js");

    const result = await purchasePlanForUser({ userId: user.id, planId: plan.id, idempotencyKey: "renew-null", now: Date.parse("2026-06-10T00:00:00Z") });

    expect(result.action).toBe("renew");
    expect(result.user.planExpiresAt).toBe("2026-06-20T00:00:00.000Z");
  });

  it("changes active plan and clears plan quota state", async () => {
    const oldPlan = await createPricedPlan({ priceCredits: 1 });
    const newPlan = await createPricedPlan({ priceCredits: 7, durationDays: 15 });
    const user = await setupUser({ credits: 20, planId: oldPlan.id, planExpiresAt: "2026-06-20T00:00:00.000Z" });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO kv(scope, key, value) VALUES('planQuotaState', ?, ?)`, [user.id, JSON.stringify({ winWeek: { startedAt: "x" } })]);
    const { purchasePlanForUser } = await import("@/lib/plans/planPurchase.js");

    const result = await purchasePlanForUser({ userId: user.id, planId: newPlan.id, idempotencyKey: "change-1", now: Date.parse("2026-06-10T00:00:00Z") });

    expect(result.action).toBe("change");
    expect(result.user.creditsBalance).toBe(13);
    expect(result.user.planExpiresAt).toBe("2026-06-25T00:00:00.000Z");
    expect(JSON.parse(db.get(`SELECT value FROM kv WHERE scope='planQuotaState' AND key=?`, [user.id]).value)).toEqual({});
  });

  it("rejects insufficient credits without ledger/user changes", async () => {
    const user = await setupUser({ credits: 3 });
    const plan = await createPricedPlan({ priceCredits: 10 });
    const { purchasePlanForUser, PlanPurchaseError } = await import("@/lib/plans/planPurchase.js");

    await expect(purchasePlanForUser({ userId: user.id, planId: plan.id, idempotencyKey: "poor" })).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS", requiredCredits: 10, creditsBalance: 3 });

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.get(`SELECT COUNT(*) AS c FROM creditTransactions WHERE userId=?`, [user.id]).c).toBe(0);
    expect(db.get(`SELECT creditsBalance, planId FROM users WHERE id=?`, [user.id])).toMatchObject({ creditsBalance: 3, planId: null });
    expect(PlanPurchaseError).toBeTruthy();
  });

  it("idempotent retry does not charge or extend twice", async () => {
    const user = await setupUser({ credits: 50 });
    const plan = await createPricedPlan({ priceCredits: 10, durationDays: 30 });
    const { purchasePlanForUser } = await import("@/lib/plans/planPurchase.js");

    const first = await purchasePlanForUser({ userId: user.id, planId: plan.id, idempotencyKey: "same", now: Date.parse("2026-06-10T00:00:00Z") });
    const second = await purchasePlanForUser({ userId: user.id, planId: plan.id, idempotencyKey: "same", now: Date.parse("2026-06-11T00:00:00Z") });

    expect(first.user.creditsBalance).toBe(40);
    expect(second.idempotent).toBe(true);
    expect(second.user.creditsBalance).toBe(40);
    expect(second.user.planExpiresAt).toBe(first.user.planExpiresAt);
  });

  it("rolls back ledger when final user activation update fails", async () => {
    const user = await setupUser({ credits: 50 });
    const plan = await createPricedPlan({ priceCredits: 10, durationDays: 30 });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`CREATE TRIGGER fail_plan_activation BEFORE UPDATE OF planId ON users WHEN NEW.planId = '${plan.id}' BEGIN SELECT RAISE(ABORT, 'forced plan update failure'); END`);
    const { purchasePlanForUser } = await import("@/lib/plans/planPurchase.js");

    await expect(purchasePlanForUser({ userId: user.id, planId: plan.id, idempotencyKey: "rollback" })).rejects.toThrow("forced plan update failure");

    expect(db.get(`SELECT COUNT(*) AS c FROM creditTransactions WHERE userId=?`, [user.id]).c).toBe(0);
    expect(db.get(`SELECT creditsBalance, planId FROM users WHERE id=?`, [user.id])).toMatchObject({ creditsBalance: 50, planId: null });
  });

  it("supports free plans and rejects inactive plans", async () => {
    const user = await setupUser({ credits: 0 });
    const free = await createPricedPlan({ priceCredits: 0 });
    const inactive = await createPricedPlan({ priceCredits: 0, isActive: false });
    const { purchasePlanForUser } = await import("@/lib/plans/planPurchase.js");

    expect((await purchasePlanForUser({ userId: user.id, planId: free.id, idempotencyKey: "free" })).transaction.amount).toBe(-0);
    await expect(purchasePlanForUser({ userId: user.id, planId: inactive.id, idempotencyKey: "inactive" })).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
  });
});
