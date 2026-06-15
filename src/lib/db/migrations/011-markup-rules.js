// Migration 011: markupRules table + products pricing columns (Story 2.31)
//
// Backward-compat (M1): all new products columns are nullable — local products
// are untouched (supplierPrice/retailPrice/expectedMargin/isPublished all null).
// Invariant: publishProduct() sets isActive=1 when isPublished=1, so
// listActiveProducts(WHERE isActive=1) continues to work for both local + external.
//
// Backfill: external products synced before 2.31 have supplierPrice=NULL
// (raw supplier price was only stored in priceCredits). Backfill copies priceCredits
// → supplierPrice so publishProduct() validation can pass immediately after migration.
function tableExists(db, name) {
  return !!db.get(
    `SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name]
  );
}

function colExists(db, table, col) {
  return db.all(`PRAGMA table_info(${table})`).some((r) => r.name === col);
}

const migration = {
  version: 11,
  name: "markup-rules",
  up(db) {
    // ── products: add pricing + publish columns (nullable, backward-compat M1) ──
    if (tableExists(db, "products")) {
      if (!colExists(db, "products", "supplierPrice")) {
        db.exec(`ALTER TABLE products ADD COLUMN supplierPrice REAL`);
      }
      if (!colExists(db, "products", "retailPrice")) {
        db.exec(`ALTER TABLE products ADD COLUMN retailPrice REAL`);
      }
      if (!colExists(db, "products", "expectedMargin")) {
        db.exec(`ALTER TABLE products ADD COLUMN expectedMargin REAL`);
      }
      if (!colExists(db, "products", "isPublished")) {
        db.exec(`ALTER TABLE products ADD COLUMN isPublished INTEGER DEFAULT 0`);
      }

      // Backfill: external products synced before 2.31 have supplierPrice=NULL.
      // Copy priceCredits (which held raw supplier price) so admin can publish
      // immediately without waiting for the next sync cycle.
      db.exec(`
        UPDATE products
        SET supplierPrice = priceCredits
        WHERE source = 'external_telegram_store'
          AND supplierPrice IS NULL
      `);
    }

    // ── markupRules table (CREATE IF NOT EXISTS — idempotent) ──
    // Priority lookup order: product-level → supplier-level → global (no category tier —
    // products table has no category column, so category binds would never match).
    db.exec(`
      CREATE TABLE IF NOT EXISTS markupRules (
        id TEXT PRIMARY KEY,
        supplierId TEXT,
        productId TEXT,
        markupPct REAL NOT NULL,
        roundingRule TEXT DEFAULT 'none',
        isActive INTEGER DEFAULT 1,
        createdAt TEXT,
        updatedAt TEXT
      )
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_markup_supplier ON markupRules(supplierId)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_markup_product ON markupRules(productId)`
    );
  },
};

export default migration;
