import { getAdapter } from "@/lib/db/driver.js";
import { recordCreditTxn } from "@/lib/db/repos/creditLedgerRepo.js";

export class PlanPurchaseError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = "PlanPurchaseError";
    this.code = code;
    Object.assign(this, details);
  }
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName || null,
    isActive: row.isActive === 1 || row.isActive === true,
    isEmailVerified: row.isEmailVerified === 1 || row.isEmailVerified === true,
    creditsBalance: row.creditsBalance ?? 0,
    planId: row.planId ?? null,
    planExpiresAt: row.planExpiresAt ?? null,
    allowCreditOverflow: row.allowCreditOverflow === 1 || row.allowCreditOverflow === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName || null,
    rpm: row.rpm ?? 0,
    quota5h: row.quota5h ?? 0,
    quotaWeekly: row.quotaWeekly ?? 0,
    priceCredits: row.priceCredits ?? 0,
    durationDays: row.durationDays ?? 30,
    perModelLimits: row.perModelLimits ? JSON.parse(row.perModelLimits) : null,
    isActive: row.isActive === 1 || row.isActive === true,
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateIdempotencyKey(idempotencyKey) {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 128) {
    throw new PlanPurchaseError("INVALID_IDEMPOTENCY_KEY", "Invalid idempotencyKey");
  }
  return idempotencyKey.trim();
}

function assertValidPlanForPurchase(plan) {
  if (!plan) throw new PlanPurchaseError("PLAN_NOT_FOUND", "Plan not found");
  if (!Number.isFinite(plan.priceCredits) || plan.priceCredits < 0) {
    throw new PlanPurchaseError("INVALID_PLAN", "Plan price is invalid");
  }
  if (!Number.isInteger(plan.durationDays) || plan.durationDays < 1) {
    throw new PlanPurchaseError("INVALID_PLAN", "Plan duration is invalid");
  }
}

function activeCurrentPlan(user, nowMs) {
  if (!user.planId) return false;
  if (!user.planExpiresAt) return true;
  const expires = Date.parse(user.planExpiresAt);
  return Number.isFinite(expires) && expires > nowMs;
}

function addDays(baseMs, days) {
  return new Date(baseMs + days * 24 * 60 * 60 * 1000).toISOString();
}

function computeLifecycle(user, plan, nowMs) {
  const hasActivePlan = activeCurrentPlan(user, nowMs);
  const samePlan = hasActivePlan && user.planId === plan.id;
  if (samePlan) {
    const currentExpiry = user.planExpiresAt ? Date.parse(user.planExpiresAt) : NaN;
    const base = Number.isFinite(currentExpiry) ? Math.max(nowMs, currentExpiry) : nowMs;
    return { action: "renew", expiresAt: addDays(base, plan.durationDays), resetPlanQuotaState: false };
  }
  const action = hasActivePlan && user.planId !== plan.id ? "change" : "buy";
  return { action, expiresAt: addDays(nowMs, plan.durationDays), resetPlanQuotaState: action === "change" };
}

export async function purchasePlanForUser({ userId, planId, idempotencyKey, now = Date.now() }) {
  if (typeof userId !== "string" || !userId.trim()) throw new PlanPurchaseError("INVALID_USER", "Invalid userId");
  if (typeof planId !== "string" || !planId.trim()) throw new PlanPurchaseError("PLAN_NOT_FOUND", "Plan not found");
  const clientKey = validateIdempotencyKey(idempotencyKey);
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new PlanPurchaseError("INVALID_NOW", "Invalid now");
  const internalKey = `plan_activation:${userId}:${clientKey}`;

  const db = await getAdapter();
  let result;

  db.transaction(() => {
    const existing = db.get(`SELECT * FROM creditTransactions WHERE idempotencyKey = ?`, [internalKey]);
    if (existing) {
      const user = rowToUser(db.get(`SELECT * FROM users WHERE id = ?`, [userId]));
      const plan = rowToPlan(db.get(`SELECT * FROM plans WHERE id = ?`, [user?.planId || planId]));
      result = { action: "buy", plan, user, transaction: existing, idempotent: true, resetPlanQuotaState: false };
      return;
    }

    const user = rowToUser(db.get(`SELECT * FROM users WHERE id = ?`, [userId]));
    if (!user) throw new PlanPurchaseError("INVALID_USER", "User not found");
    const plan = rowToPlan(db.get(`SELECT * FROM plans WHERE id = ? AND isActive = 1`, [planId]));
    assertValidPlanForPurchase(plan);

    if ((user.creditsBalance ?? 0) < plan.priceCredits) {
      throw new PlanPurchaseError("INSUFFICIENT_CREDITS", "Insufficient credits", {
        requiredCredits: plan.priceCredits,
        creditsBalance: user.creditsBalance ?? 0,
        topupHref: "/dashboard/credits",
      });
    }

    const lifecycle = computeLifecycle(user, plan, nowMs);
    const txn = recordCreditTxn({
      userId,
      type: "plan_activation",
      bucket: "standard",
      amount: -plan.priceCredits,
      refId: plan.id,
      idempotencyKey: internalKey,
      note: `${lifecycle.action} plan ${plan.name}`,
    }, db);

    const updatedAt = new Date(nowMs).toISOString();
    db.run(`UPDATE users SET planId = ?, planExpiresAt = ?, updatedAt = ? WHERE id = ?`, [plan.id, lifecycle.expiresAt, updatedAt, userId]);
    if (lifecycle.resetPlanQuotaState) {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('planQuotaState', ?, '{}') ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [userId]
      );
    }

    result = {
      action: lifecycle.action,
      plan,
      user: rowToUser(db.get(`SELECT * FROM users WHERE id = ?`, [userId])),
      transaction: txn,
      idempotent: false,
      resetPlanQuotaState: lifecycle.resetPlanQuotaState,
    };
  });

  return result;
}
