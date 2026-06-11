// Migration 006: store v2 — reservedAt on productCredentials, fulfilledAt on orders (Story 2.27)
const migration = {
  version: 6,
  name: "store-v2",
  up(db) {
    const credCols = new Set(
      db.all(`PRAGMA table_info(productCredentials)`).map((r) => r.name)
    );
    if (!credCols.has("reservedAt")) {
      db.exec(`ALTER TABLE productCredentials ADD COLUMN reservedAt TEXT`);
    }

    const orderCols = new Set(
      db.all(`PRAGMA table_info(orders)`).map((r) => r.name)
    );
    if (!orderCols.has("fulfilledAt")) {
      db.exec(`ALTER TABLE orders ADD COLUMN fulfilledAt TEXT`);
    }
  },
};

export default migration;
