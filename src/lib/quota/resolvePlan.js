import { getUserById } from "../db/repos/usersRepo.js";
import { getPlanById } from "../db/repos/plansRepo.js";

/**
 * Resolve effective limits for a user.
 *
 * Returns one of:
 *   { source: "plan", planId, planName, rpm, quota5h, quotaWeekly, perModelLimits, modelLimit }
 *   { source: "credit" }                       — no plan / expired / inactive plan
 *   { source: "credit", expired: true }        — plan exists but past planExpiresAt
 *
 * Fail-open: any DB/parse error → { source: "credit" } + warn log (never blocks).
 *
 * @param {string} userId
 * @param {string|null} model - canonical model id (optional; drives modelLimit resolution)
 * @returns {Promise<object>}
 */
export async function resolveUserLimits(userId, model = null) {
  try {
    const user = await getUserById(userId);
    if (!user) return { source: "credit" };

    const { planId, planExpiresAt } = user;
    if (!planId) return { source: "credit" };

    if (planExpiresAt) {
      const expMs = new Date(planExpiresAt).getTime();
      // Malformed/unparseable date → treat as expired (fail-safe to credit),
      // never silently grant the plan on a NaN comparison.
      if (Number.isNaN(expMs) || expMs <= Date.now()) {
        return { source: "credit", expired: true };
      }
    }

    const plan = await getPlanById(planId);
    if (!plan || !plan.isActive) return { source: "credit" };

    const result = {
      source: "plan",
      planId: plan.id,
      planName: plan.name,
      rpm: plan.rpm ?? 0,
      quota5h: plan.quota5h ?? 0,
      quotaWeekly: plan.quotaWeekly ?? 0,
      perModelLimits: plan.perModelLimits ?? null,
      modelLimit: null,
    };

    // Per-model override: if model supplied and plan has an entry for it, expose it
    if (model && plan.perModelLimits && typeof plan.perModelLimits === "object") {
      const entry = plan.perModelLimits[model];
      if (entry) {
        result.modelLimit = {
          quota5h: entry.q5h ?? result.quota5h,
          quotaWeekly: entry.qWeekly ?? result.quotaWeekly,
        };
      }
    }

    return result;
  } catch (err) {
    console.warn("[resolvePlan] resolveUserLimits error — fail-open:", err.message);
    return { source: "credit" };
  }
}
