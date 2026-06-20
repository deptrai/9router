/**
 * Migration 014 — Affiliate/Referral: thêm refCode + referredBy vào users (Story 2.37)
 */

function columnExists(db, table, column) {
  const cols = db.all(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

const migration = {
  version: 14,
  name: "affiliate",
  up(db) {
    if (!columnExists(db, "users", "refCode")) {
      db.exec(`ALTER TABLE users ADD COLUMN refCode TEXT`);
    }
    if (!columnExists(db, "users", "referredBy")) {
      db.exec(`ALTER TABLE users ADD COLUMN referredBy TEXT`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_refCode ON users(refCode)`);

    // Backfill existing users with random 8-hex refCode
    const users = db.all(`SELECT id FROM users WHERE refCode IS NULL`);
    const usedCodes = new Set();

    for (const user of users) {
      let code;
      do {
        code = [...Array(8)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
      } while (usedCodes.has(code));
      usedCodes.add(code);
      db.run(`UPDATE users SET refCode = ? WHERE id = ?`, [code, user.id]);
    }
  },
};

export default migration;
