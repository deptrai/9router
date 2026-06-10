import { getAdapter } from "@/lib/db/driver.js";
import { reconcileUserBalance } from "@/lib/db/repos/creditLedgerRepo.js";
import { getMetaSync, setMetaSync } from "@/lib/db/helpers/metaStore.js";

const META_LAST_SWEEP_AT = "creditSweep:lastSweepAt";
const DEFAULT_LOOKBACK_MS = 25 * 60 * 60 * 1000;

export async function runExpirySweep() {
  const adapter = await getAdapter();
  const now = new Date().toISOString();
  const since = getMetaSync(adapter, META_LAST_SWEEP_AT, new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString());
  const rows = adapter.all(
    `SELECT DISTINCT userId FROM creditTransactions
     WHERE expiresAt IS NOT NULL AND expiresAt > ? AND expiresAt <= ?`,
    [since, now]
  );

  const result = { scanned: rows.length, reconciled: 0, failed: 0 };
  for (const row of rows) {
    try {
      await reconcileUserBalance(row.userId, adapter);
      result.reconciled += 1;
    } catch (e) {
      result.failed += 1;
      console.warn("[creditSweep] reconcile failed for", row.userId, e?.message || e);
    }
  }
  setMetaSync(adapter, META_LAST_SWEEP_AT, now);
  return result;
}
