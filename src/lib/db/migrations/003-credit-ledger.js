// Migration 003: creditTransactions immutable ledger (Story 2.13, E.3b)
// BP-1: append-only, no updatedAt column.
// BP-6: amount/balanceAfter REAL (float) — known-limitation documented in story 2.13.
export default {
  version: 3,
  name: "credit-ledger",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS creditTransactions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        type TEXT NOT NULL,
        bucket TEXT NOT NULL DEFAULT 'standard',
        amount REAL NOT NULL,
        multiplier REAL DEFAULT 1,
        expiresAt TEXT,
        refId TEXT,
        idempotencyKey TEXT,
        balanceAfter REAL,
        note TEXT,
        createdAt TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_user_ts ON creditTransactions(userId, createdAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ct_user_bucket ON creditTransactions(userId, bucket)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ct_idempotency ON creditTransactions(idempotencyKey)`);

    // AC#6: Seed migration row for every existing user with creditsBalance > 0.
    // idempotencyKey = 'migration:<userId>' — UNIQUE index prevents double-seeding.
    const now = new Date().toISOString();
    const users = db.all(`SELECT id, creditsBalance FROM users WHERE creditsBalance > 0`);
    for (const u of users) {
      db.run(
        `INSERT OR IGNORE INTO creditTransactions(id, userId, type, bucket, amount, multiplier, expiresAt, refId, idempotencyKey, balanceAfter, note, createdAt)
         VALUES(lower(hex(randomblob(16))), ?, 'migration', 'standard', ?, 1, NULL, NULL, ?, ?, 'seed existing balance from migration 003', ?)`,
        [u.id, u.creditsBalance, `migration:${u.id}`, u.creditsBalance, now]
      );
    }
  },
};
