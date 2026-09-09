// Migration 018 — add isAdmin flag to users.
// Admin is now a regular user with elevated privileges (no separate password
// login). A user whose email matches process.env.ADMIN_EMAIL is promoted here
// if the row already exists; login/register also promote on first sign-in.
const migration = {
  version: 18,
  name: "users-is-admin",
  up(db) {
    // ALTER TABLE ADD COLUMN is not idempotent on SQLite — guard via PRAGMA.
    const cols = db.all(`PRAGMA table_info(users)`);
    if (!cols.some((c) => c.name === "isAdmin")) {
      db.exec(`ALTER TABLE users ADD COLUMN isAdmin INTEGER NOT NULL DEFAULT 0`);
    }
    // Promote the configured admin email if that user already exists.
    const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (adminEmail) {
      db.run(`UPDATE users SET isAdmin = 1 WHERE lower(email) = ?`, [adminEmail]);
    }
  },
};

export default migration;
