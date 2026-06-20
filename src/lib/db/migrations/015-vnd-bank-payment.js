/**
 * Migration 015 — VND bank transfer payment fields (Story 2-39)
 * Adds method, memo, amountVnd, confirmedAt, rawWebhook columns.
 * Makes network/coin nullable for non-crypto payments.
 */

function columnExists(db, table, column) {
  const cols = db.all(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

const migration = {
  version: 15,
  name: "vnd-bank-payment",
  up(db) {
    if (!columnExists(db, "payments", "method")) {
      db.exec(`ALTER TABLE payments ADD COLUMN method TEXT DEFAULT 'crypto'`);
    }
    if (!columnExists(db, "payments", "memo")) {
      db.exec(`ALTER TABLE payments ADD COLUMN memo TEXT`);
    }
    if (!columnExists(db, "payments", "amountVnd")) {
      db.exec(`ALTER TABLE payments ADD COLUMN amountVnd INTEGER`);
    }
    if (!columnExists(db, "payments", "credits")) {
      db.exec(`ALTER TABLE payments ADD COLUMN credits REAL`);
    }
    if (!columnExists(db, "payments", "confirmedAt")) {
      db.exec(`ALTER TABLE payments ADD COLUMN confirmedAt TEXT`);
    }
    if (!columnExists(db, "payments", "rawWebhook")) {
      db.exec(`ALTER TABLE payments ADD COLUMN rawWebhook TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_payments_memo ON payments(memo)`);
  },
};

export default migration;
