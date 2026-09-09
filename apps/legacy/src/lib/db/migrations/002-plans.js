// Migration 002: plans table + users.planId/planExpiresAt
export default {
  version: 2,
  name: "plans",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        displayName TEXT,
        rpm INTEGER DEFAULT 0,
        quota5h INTEGER DEFAULT 0,
        quotaWeekly INTEGER DEFAULT 0,
        perModelLimits TEXT,
        isActive INTEGER DEFAULT 1,
        sortOrder INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_plans_name ON plans(name)`);

    // Idempotent ADD COLUMN — guard against column already existing
    const userCols = new Set(
      db.all(`PRAGMA table_info(users)`).map((r) => r.name)
    );
    if (!userCols.has("planId")) {
      db.exec(`ALTER TABLE users ADD COLUMN planId TEXT`);
    }
    if (!userCols.has("planExpiresAt")) {
      db.exec(`ALTER TABLE users ADD COLUMN planExpiresAt TEXT`);
    }

    // Seed default plans (idempotent via INSERT OR IGNORE on name UNIQUE)
    const now = new Date().toISOString();
    const plans = [
      { name: "free",  displayName: "Free",  rpm: 10, quota5h: 200000,   quotaWeekly: 1000000,  sortOrder: 0 },
      { name: "pro",   displayName: "Pro",   rpm: 20, quota5h: 2000000,  quotaWeekly: 20000000, sortOrder: 1 },
      { name: "max",   displayName: "Max",   rpm: 30, quota5h: 8000000,  quotaWeekly: 80000000, sortOrder: 2 },
    ];
    for (const p of plans) {
      db.run(
        `INSERT OR IGNORE INTO plans(id, name, displayName, rpm, quota5h, quotaWeekly, perModelLimits, isActive, sortOrder, createdAt, updatedAt)
         VALUES(lower(hex(randomblob(16))), ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
        [p.name, p.displayName, p.rpm, p.quota5h, p.quotaWeekly, p.sortOrder, now, now]
      );
    }
  },
};
