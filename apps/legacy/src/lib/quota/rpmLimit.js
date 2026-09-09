import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { resolveUserLimits } from "@/lib/quota/resolvePlan.js";
import { getRpmState, setRpmState } from "@/lib/db/repos/quotaRepo.js";
import { duration, resolveWindow } from "@/lib/quota/window.js";

/**
 * checkRpmLimit — RPM admission guard (Story 2.12, E.2)
 *
 * Counts requests per-user (all keys pooled) in a 1m session window.
 * Fail-CLOSED when limit exceeded; fail-OPEN on infrastructure errors.
 *
 * Returns { allowed: true } when:
 *   - apiKey is empty/null
 *   - key not found or is legacy (userId = null)
 *   - user has no active plan (source = "credit")
 *   - plan rpm = 0 (unlimited)
 *   - any DB/resolver exception (fail-open — infra errors MUST NOT block requests)
 *
 * Returns { allowed: false, retryAfter, retryAfterHuman, rpm, count, planName } when:
 *   - source === "plan" && rpm > 0 && count >= rpm (user genuinely over limit)
 *
 * NOTE: read-modify-write on the kv counter is not atomic. Two concurrent requests
 * from the same user may both pass at count=rpm-1. This is an accepted soft-limit
 * at MVP (same pattern deferred in story 2.3 for 10-key limit). Harden with an
 * atomic UPDATE ... WHERE count < rpm if strict enforcement is needed later.
 *
 * @param {string|null} apiKey
 * @param {number} [now] - epoch ms, default Date.now()
 * @returns {Promise<{ allowed: boolean, retryAfter?: string, retryAfterHuman?: string, rpm?: number, count?: number, planName?: string }>}
 */
export async function checkRpmLimit(apiKey, now = Date.now()) {
  try {
    if (!apiKey) return { allowed: true };

    const keyRow = await getApiKeyByKey(apiKey);
    if (!keyRow?.userId) return { allowed: true }; // legacy or not found

    const limits = await resolveUserLimits(keyRow.userId);
    if (limits.source !== "plan" || !(limits.rpm > 0)) return { allowed: true };

    const state = await getRpmState(keyRow.userId);
    const win = resolveWindow(state.win1m ?? null, "1m", now);

    const count = win.reset ? 0 : (state.win1m?.count ?? 0);

    if (count >= limits.rpm) {
      // Fail-CLOSED: user is genuinely over the limit
      const resetAt = new Date(new Date(win.startedAt).getTime() + duration("1m")).toISOString();
      const sec = Math.ceil((new Date(resetAt).getTime() - now) / 1000);
      const retryAfterHuman = `reset after ${Math.max(sec, 1)}s`;
      return {
        allowed: false,
        retryAfter: resetAt,
        retryAfterHuman,
        rpm: limits.rpm,
        count,
        planName: limits.planName,
      };
    }

    // Under limit — increment and persist
    await setRpmState(keyRow.userId, {
      win1m: { startedAt: win.startedAt, count: count + 1 },
    });
    return { allowed: true };
  } catch (e) {
    // Fail-OPEN: infrastructure errors must not block requests
    console.warn("[rpmLimit] fail-open:", e.message);
    return { allowed: true };
  }
}
