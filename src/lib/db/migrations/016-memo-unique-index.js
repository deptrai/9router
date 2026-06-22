/**
 * Migration 016 — UNIQUE partial index on payments.memo
 * Prevents memo collision (birthday-paradox risk at scale) from causing
 * a webhook to settle the wrong payment row.
 * Partial index (WHERE memo IS NOT NULL) so crypto payments (memo=NULL) are unaffected.
 */

const migration = {
  version: 16,
  name: "memo-unique-index",
  up(db) {
    db.exec(`DROP INDEX IF EXISTS idx_payments_memo`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_memo_unique ON payments(memo) WHERE memo IS NOT NULL`);
  },
};

export default migration;
