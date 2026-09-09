import { getAdapter } from "@/lib/db/driver.js";
import { reconcileUserBalance } from "@/lib/db/repos/creditLedgerRepo.js";
import { getMetaSync, setMetaSync } from "@/lib/db/helpers/metaStore.js";

const META_LAST_SWEEP_AT = "creditSweep:lastSweepAt";
const EPOCH_ISO = new Date(0).toISOString();

export async function runExpirySweep() {
  const adapter = await getAdapter();
  const now = new Date().toISOString();
  // Review patch (P3): cold-start (no stored cursor) must full-scan from epoch — a 25h
  // lookback silently drops every credit that expired >25h before this process started.
  const since = getMetaSync(adapter, META_LAST_SWEEP_AT, EPOCH_ISO);
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
  // Review patch (P2): only advance the cursor when every user reconciled. Advancing past
  // a failed user moves `since` beyond their expiry timestamp → they are never re-swept
  // (lost forever). On partial failure, leave the cursor so the next sweep retries the window.
  if (result.failed === 0) {
    setMetaSync(adapter, META_LAST_SWEEP_AT, now);
  }
  return result;
}
