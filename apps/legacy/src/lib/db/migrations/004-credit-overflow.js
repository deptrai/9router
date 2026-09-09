// Migration 004: users.allowCreditOverflow — Model B credit overflow toggle (Story 2.14, E.3)
// Default 0 (OFF): plan quota exhausted → block 429 (principle of least surprise for money).
// User explicitly opts in to allow seamless overflow to credit billing.
export default {
  version: 4,
  name: "credit-overflow",
  up(db) {
    const userCols = new Set(
      db.all(`PRAGMA table_info(users)`).map((r) => r.name)
    );
    if (!userCols.has("allowCreditOverflow")) {
      db.exec(`ALTER TABLE users ADD COLUMN allowCreditOverflow INTEGER DEFAULT 0`);
    }
  },
};
