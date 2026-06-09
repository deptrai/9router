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
 * Enforces TOTAL tokens across all models plus optional per-model override caps.
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
 * @param {string|null} model  — canonical model id for optional per-model override checks
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

    const exhaustedResult = ({ type, quota, consumed, startedAt, scope = "total" }) => {
      const resetAt = new Date(new Date(startedAt).getTime() + duration(type)).toISOString();
      const retryAfterHuman = formatResetCountdown(resetAt, now);
      return {
        source: "plan",
        allowed: false,
        exhausted: true,
        scope,
        ...(scope === "model" ? { model } : {}),
        window: type,
        consumed,
        limit: quota,
        planName: limits.planName,
        allowCreditOverflow,
        retryAfter: resetAt,
        retryAfterHuman,
      };
    };

    // Check each total window first; total behavior wins over per-model overrides.
    const windows = [
      { key: "win5h", type: "5h", quota: limits.quota5h, modelQuota: limits.modelLimit?.quota5h },
      { key: "winWeek", type: "weekly", quota: limits.quotaWeekly, modelQuota: limits.modelLimit?.quotaWeekly },
    ];

    const resolvedWindows = [];

    for (const { key, type, quota, modelQuota } of windows) {
      const resolved = resolveWindow(state[key] ?? null, type, now);
      if (resolved.reset) {
        newState[key] = { startedAt: resolved.startedAt };
        stateChanged = true;
      }

      const startedAt = newState[key]?.startedAt ?? resolved.startedAt;
      resolvedWindows.push({ type, quota, modelQuota, startedAt });
      if (!quota || quota <= 0) continue; // 0 = unlimited, skip total check

      const consumed = await sumUsageTokensByUser(keyRow.userId, null, startedAt);

      if (consumed >= quota) {
        if (stateChanged) await setPlanQuotaState(keyRow.userId, newState);
        return exhaustedResult({ type, quota, consumed, startedAt, scope: "total" });
      }
    }

    // Then apply matching per-model caps, if resolveUserLimits exposed one.
    if (model && limits.modelLimit) {
      for (const { type, modelQuota, startedAt } of resolvedWindows) {
        if (!modelQuota || modelQuota <= 0) continue; // 0 = unlimited for this model window only
        const consumed = await sumUsageTokensByUser(keyRow.userId, model, startedAt);
        if (consumed >= modelQuota) {
          if (stateChanged) await setPlanQuotaState(keyRow.userId, newState);
          return exhaustedResult({ type, quota: modelQuota, consumed, startedAt, scope: "model" });
        }
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
