/**
 * planQuotaStatus.js — READ-ONLY quota status for UI (Story 2.15, E.4)
 *
 * CRITICAL: This is a read-only variant of checkPlanQuota.
 * - DOES NOT persist window state (no setPlanQuotaState)
 * - DOES NOT return allowed/exhausted/429 semantics (not an admission check)
 * - ONLY reads current consumption and window state for display purposes
 *
 * Used by GET /api/users/me/quota to show users their quota status without
 * side-effects (opening the page should never reset windows or affect enforcement).
 */

import { getUserById } from "@/lib/db/repos/usersRepo.js";
import { resolveUserLimits } from "@/lib/quota/resolvePlan.js";
import { getPlanQuotaState, getRpmState, sumUsageTokensByUser } from "@/lib/db/repos/quotaRepo.js";
import { duration, resolveWindow } from "@/lib/quota/window.js";

/**
 * Get read-only quota status snapshot for a user.
 *
 * Returns:
 *   { source:"none" }                                                     — no user
 *   { source:"credit", creditsBalance, allowCreditOverflow }             — pay-as-you-go
 *   { source:"plan", planName, planExpiresAt, rpm, rpmUsed,
 *     quota5h:{limit,consumed,resetAt}, quotaWeekly:{limit,consumed,resetAt},
 *     creditsBalance, allowCreditOverflow }                              — active plan
 *   { source:"error" }                                                   — fail-soft
 *
 * @param {string} userId
 * @param {number} [now] - epoch ms, default Date.now()
 */
export async function getPlanQuotaStatus(userId, now = Date.now()) {
  try {
    const user = await getUserById(userId);
    if (!user) return { source: "none" };

    const limits = await resolveUserLimits(userId, null);
    const creditsBalance = user.creditsBalance ?? 0;
    const allowCreditOverflow = user.allowCreditOverflow ?? false;

    if (limits.source !== "plan") {
      return { source: "credit", creditsBalance, allowCreditOverflow };
    }

    const state = await getPlanQuotaState(userId);
    const result = {
      source: "plan",
      planName: limits.planName,
      planExpiresAt: user.planExpiresAt ?? null,
      rpm: limits.rpm ?? 0,
      rpmUsed: 0,
      quota5h: { limit: 0, consumed: 0, resetAt: null },
      quotaWeekly: { limit: 0, consumed: 0, resetAt: null },
      creditsBalance,
      allowCreditOverflow,
    };

    const rpmState = await getRpmState(userId);
    const rpmResolved = resolveWindow(rpmState.win1m ?? null, "1m", now);
    result.rpmUsed = rpmResolved.reset ? 0 : (rpmState.win1m?.count ?? 0);

    const windows = [
      { key: "win5h", type: "5h", quotaLimit: limits.quota5h, resultKey: "quota5h" },
      { key: "winWeek", type: "weekly", quotaLimit: limits.quotaWeekly, resultKey: "quotaWeekly" },
    ];

    for (const { key, type, quotaLimit, resultKey } of windows) {
      const limit = quotaLimit ?? 0;
      result[resultKey].limit = limit;

      if (limit <= 0) {
        result[resultKey].consumed = 0;
        result[resultKey].resetAt = null;
        continue;
      }

      const resolved = resolveWindow(state[key] ?? null, type, now);
      const startedAt = resolved.startedAt;
      result[resultKey].resetAt = new Date(new Date(startedAt).getTime() + duration(type)).toISOString();
      result[resultKey].consumed = await sumUsageTokensByUser(userId, null, new Date(startedAt).getTime());
    }

    return result;
  } catch (err) {
    console.warn("[planQuotaStatus] getPlanQuotaStatus fail-soft:", err.message);
    return { source: "error" };
  }
}
