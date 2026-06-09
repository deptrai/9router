// Migration 005: plan purchase price/duration fields (Story 2.18, E.7)
const migration = {
  version: 5,
  name: "plan-purchase-fields",
  up(db) {
    const planCols = new Set(
      db.all(`PRAGMA table_info(plans)`).map((r) => r.name)
    );
    if (!planCols.has("priceCredits")) {
      db.exec(`ALTER TABLE plans ADD COLUMN priceCredits REAL DEFAULT 0`);
    }
    if (!planCols.has("durationDays")) {
      db.exec(`ALTER TABLE plans ADD COLUMN durationDays INTEGER DEFAULT 30`);
    }

    db.run(`UPDATE plans SET priceCredits = 0 WHERE priceCredits IS NULL`);
    db.run(`UPDATE plans SET durationDays = 30 WHERE durationDays IS NULL`);
    db.run(`UPDATE plans SET priceCredits = 0, durationDays = COALESCE(durationDays, 30) WHERE name = 'free' AND (priceCredits IS NULL OR priceCredits = 0)`);
    db.run(`UPDATE plans SET priceCredits = 10, durationDays = COALESCE(durationDays, 30) WHERE name = 'pro' AND (priceCredits IS NULL OR priceCredits = 0)`);
    db.run(`UPDATE plans SET priceCredits = 30, durationDays = COALESCE(durationDays, 30) WHERE name = 'max' AND (priceCredits IS NULL OR priceCredits = 0)`);
  },
};

export default migration;
