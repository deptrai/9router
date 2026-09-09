// Migration 005: plan purchase price/duration fields (Story 2.18, E.7)
const migration = {
  version: 5,
  name: "plan-purchase-fields",
  up(db) {
    const planCols = new Set(
      db.all(`PRAGMA table_info(plans)`).map((r) => r.name)
    );
    const addedDurationDays = !planCols.has("durationDays");

    if (!planCols.has("priceCredits")) {
      db.exec(`ALTER TABLE plans ADD COLUMN priceCredits REAL DEFAULT 0`);
    }
    if (addedDurationDays) {
      db.exec(`ALTER TABLE plans ADD COLUMN durationDays INTEGER DEFAULT 30`);
    }

    db.run(`UPDATE plans SET durationDays = 30 WHERE durationDays IS NULL`);
    const defaultPricesSeeded = db.get(
      `SELECT value FROM _meta WHERE key = 'planPurchaseDefaultPricesSeeded'`
    )?.value === "1";
    if (!defaultPricesSeeded) {
      db.run(`UPDATE plans SET priceCredits = 0 WHERE name = 'free'`);
      db.run(`UPDATE plans SET priceCredits = 10 WHERE name = 'pro'`);
      db.run(`UPDATE plans SET priceCredits = 30 WHERE name = 'max'`);
      db.run(
        `INSERT INTO _meta(key, value) VALUES('planPurchaseDefaultPricesSeeded', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
    }
    db.run(`UPDATE plans SET priceCredits = 0 WHERE priceCredits IS NULL`);
  },
};

export default migration;
