/**
 * planQuota.js — Per-user plan quota enforcement (Story 2.14, E.3 — Model B)
 *
 * Checks whether the user's plan quota (5h / weekly token windows) is exhausted.
 * Returns billingSource decision + allowCreditOverflow flag so chat.js can decide
 * whether to block, overflow-to-credit, or proceed within plan.
 *
 * Fail-open: any DB/resolver/parse error → { source:"error", allowed:true } + warn.
 * Only blocks when CERTAIN the user has a valid active plan AND quota exhausted AND
 * overflow toggle is OFF. Mirrors checkKeyQuota / checkRpmLimit philosophy.
 *
 * quota=0 means unlimited for that window (skip enforcement).
 * Enforces TOTAL tokens across all models. Per-model override (E.6) is out of scope.
 *
 * @module planQuota
 */

import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getUserById } from "@/lib/db/repos/usersRepo.js";
import { resolveUserLimits } from "@/lib/quota/resolvePlan.js";
import { getPlanQuotaState, setPlanQuotaState, sumUsageTokensByUser } from "@/lib/db/repos/quotaRepo.js";
import { duration, resolveWindow, formatResetCountdown } from "@/lib/quota/window.js";

/**
 * Check plan quota for a request.
 *
 * Returns:
 *   { source:"none",    allowed:true }                                   — no apiKey / legacy / no plan
 *   { source:"credit",  allowed:true }                                   — user has no active plan
 *   { source:"plan",    allowed:true,  allowCreditOverflow, planName }   — within quota
 *   { source:"plan",    allowed:false, exhausted:true, window, consumed,
 *                       limit, planName, allowCreditOverflow,
 *                       retryAfter, retryAfterHuman }                    — quota exhausted
 *   { source:"error",   allowed:true }                                   — infrastructure error (fail-open)
 *
 * @param {string|null} apiKey
 * @param {string|null} model  — canonical model id (unused for total enforcement; reserved for E.6)
 * @param {number} [now]       — epoch ms, default Date.now()
 */
export async function checkPlanQuota(apiKey, model = null, now = Date.now()) {
  try {
    if (!apiKey) return { source: "none", allowed: true };

    const keyRow = await getApiKeyByKey(apiKey);
    if (!keyRow?.userId) return { source: "none", allowed: true }; // legacy / not found

    const limits = await resolveUserLimits(keyRow.userId, model);
    if (limits.source !== "plan") {
      // No active plan (credit pay-as-you-go) — caller uses credit path
      return { source: "credit", allowed: true };
    }

    // Fetch user for allowCreditOverflow toggle
    const user = await getUserById(keyRow.userId);
    const allowCreditOverflow = user?.allowCreditOverflow ?? false;

    const state = await getPlanQuotaState(keyRow.userId);
    const newState = { ...state };
    let stateChanged = false;

    // Check each window that has a non-zero quota
    const windows = [
      { key: "win5h",   type: "5h",     quota: limits.quota5h },
      { key: "winWeek", type: "weekly",  quota: limits.quotaWeekly },
    ];

    for (const { key, type, quota } of windows) {
      if (!quota || quota <= 0) continue; // 0 = unlimited, skip

      const resolved = resolveWindow(state[key] ?? null, type, now);
      if (resolved.reset) {
        newState[key] = { startedAt: resolved.startedAt };
        stateChanged = true;
      }

      const startedAt = newState[key]?.startedAt ?? resolved.startedAt;
      // Enforce TOTAL across all models (model=null)
      const consumed = await sumUsageTokensByUser(keyRow.userId, null, startedAt);

      if (consumed >= quota) {
        // Persist state (window may have reset)
        if (stateChanged) await setPlanQuotaState(keyRow.userId, newState);
        const resetAt = new Date(new Date(startedAt).getTime() + duration(type)).toISOString();
        const retryAfterHuman = formatResetCountdown(resetAt, now);
        return {
          source: "plan",
          allowed: false,
          exhausted: true,
          window: type,
          consumed,
          limit: quota,
          planName: limits.planName,
          allowCreditOverflow,
          retryAfter: resetAt,
          retryAfterHuman,
        };
      }
    }

    // All windows within quota
    if (stateChanged) await setPlanQuotaState(keyRow.userId, newState);
    return { source: "plan", allowed: true, planName: limits.planName, allowCreditOverflow };

  } catch (err) {
    console.warn("[planQuota] checkPlanQuota fail-open:", err.message);
    return { source: "error", allowed: true };
  }
}
