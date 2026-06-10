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
 */
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getUserById } from "@/lib/db/repos/usersRepo.js";
import { getBalanceByBucket } from "@/lib/db/repos/creditLedgerRepo.js";

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
    const balances = await getBalanceByBucket(user.id);
    const totalAvailable = (balances.standard ?? 0) + (balances.bonus ?? 0) + (balances.resource ?? 0);
    if (totalAvailable <= 0) {
      return { allowed: false, reason: "insufficient credits" };
    }

    return { allowed: true };
  } catch (e) {
    // Fail-open: billing errors MUST NOT block requests
    console.warn("[checkCredits] billing check failed (fail-open):", e?.message || e);
    return { allowed: true };
  }
}
