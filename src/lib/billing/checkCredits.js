/**
 * checkCredits — Credit admission guard (Story 2.4, AC2)
 *
 * Returns { allowed: true } when:
 *   - apiKey is empty/null
 *   - key not found in DB
 *   - key is legacy (userId = null) — unlimited
 *   - user not found
 *   - any DB exception (fail-open — NEVER block request due to billing error)
 *
 * Returns { allowed: false, reason } when:
 *   - user.isActive = false → "account disabled"
 *   - user.creditsBalance <= 0 → "insufficient credits"
 *
 * Per-key credit limit (Story 2.23) is exported separately as `checkPerKeyLimit`
 * so admission can call it independently of billing source (Story 2.23 D1=Option 2:
 * blast-radius guardrail applies regardless of plan/credit/overflow path).
 */
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getUserById } from "@/lib/db/repos/usersRepo.js";
import { getAdapter } from "@/lib/db/driver.js";

export async function checkCredits(apiKey) {
  try {
    if (!apiKey) return { allowed: true };

    const keyRow = await getApiKeyByKey(apiKey);
    if (!keyRow || !keyRow.userId) return { allowed: true }; // legacy or not found

    const user = await getUserById(keyRow.userId);
    if (!user) return { allowed: true }; // user not found — fail-open

    if (!user.isActive) {
      return { allowed: false, reason: "account disabled" };
    }
    if (user.creditsBalance <= 0) {
      return { allowed: false, reason: "insufficient credits" };
    }

    return { allowed: true };
  } catch (e) {
    // Fail-open: billing errors MUST NOT block requests
    console.warn("[checkCredits] billing check failed (fail-open):", e?.message || e);
    return { allowed: true };
  }
}

/**
 * checkPerKeyLimit — Per-key credit-limit guardrail (Story 2.23, D1=A cumulative).
 *
 * Independent of billing source (plan / overflow / credit) — runs as a blast-radius
 * control on every request that reaches admission. Skips legacy keys (userId=null)
 * and keys with creditLimit=null (unlimited). Fail-open on any DB error.
 */
export async function checkPerKeyLimit(apiKey) {
  try {
    if (!apiKey) return { allowed: true };

    const keyRow = await getApiKeyByKey(apiKey);
    if (!keyRow || !keyRow.userId) return { allowed: true }; // legacy / not found
    if (typeof keyRow.creditLimit !== "number") return { allowed: true }; // null = unlimited

    const adapter = await getAdapter();
    const usageRow = adapter.get(
      `SELECT COALESCE(SUM(cost), 0) AS used FROM usageHistory WHERE apiKey = ?`,
      [keyRow.key]
    );
    if ((usageRow?.used ?? 0) >= keyRow.creditLimit) {
      return { allowed: false, reason: "key credit limit reached" };
    }
    return { allowed: true };
  } catch (e) {
    // Fail-open: per story 2.4 principle, billing errors MUST NOT block requests
    console.warn("[checkPerKeyLimit] check failed (fail-open):", e?.message || e);
    return { allowed: true };
  }
}
