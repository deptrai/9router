// Migration 006: store v2 — reservedAt on productCredentials, fulfilledAt on orders (Story 2.27)
function tableExists(db, name) {
  return !!db.get(
    `SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name]
  );
}

const migration = {
  version: 6,
  name: "store-v2",
  up(db) {
    // productCredentials may not exist yet on DBs that predate its declarative
    // schema: it is created by syncSchemaFromTables() which runs AFTER versioned
    // migrations. In that case the column already ships in the declarative
    // schema, so skip the ALTER instead of throwing "no such table:
    // productCredentials" (which rolls back the whole migration and wedges the
    // app at the prior schemaVersion).
    if (tableExists(db, "productCredentials")) {
      const credCols = new Set(
        db.all(`PRAGMA table_info(productCredentials)`).map((r) => r.name)
      );
      if (!credCols.has("reservedAt")) {
        db.exec(`ALTER TABLE productCredentials ADD COLUMN reservedAt TEXT`);
      }
    }

    if (tableExists(db, "orders")) {
      const orderCols = new Set(
        db.all(`PRAGMA table_info(orders)`).map((r) => r.name)
      );
      if (!orderCols.has("fulfilledAt")) {
        db.exec(`ALTER TABLE orders ADD COLUMN fulfilledAt TEXT`);
      }
    }
  },
};

export default migration;
