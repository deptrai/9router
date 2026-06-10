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
 *   - key.creditLimit set AND keyUsage >= limit → "key credit limit reached" [story 2.23]
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

    // Story 2.23: per-key credit limit (cumulative lifetime usage, D1=A)
    if (typeof keyRow.creditLimit === "number") {
      const adapter = await getAdapter();
      const usageRow = adapter.get(
        `SELECT COALESCE(SUM(cost), 0) AS used FROM usageHistory WHERE apiKey = ?`,
        [keyRow.key]
      );
      if ((usageRow?.used ?? 0) >= keyRow.creditLimit) {
        return { allowed: false, reason: "key credit limit reached" };
      }
    }

    return { allowed: true };
  } catch (e) {
    // Fail-open: billing errors MUST NOT block requests
    console.warn("[checkCredits] billing check failed (fail-open):", e?.message || e);
    return { allowed: true };
  }
}
