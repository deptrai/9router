// Migration 009: supplierSources table + products external-store columns (Story 2.30)
//
// Backward-compat (M1): all new products columns are nullable except `source` which
// defaults to 'local' — existing local products are untouched; catalog/checkout/
// billing flows behave identically. supplierSources table is brand-new (CREATE IF NOT EXISTS).
function tableExists(db, name) {
  return !!db.get(
    `SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name]
  );
}

function colExists(db, table, col) {
  return db.all(`PRAGMA table_info(${table})`).some(r => r.name === col);
}

const migration = {
  version: 9,
  name: "external-store-sources",
  up(db) {
    // ── products: add external-store columns (nullable, backward-compat M1) ──
    if (tableExists(db, "products")) {
      if (!colExists(db, "products", "source")) {
        db.exec(`ALTER TABLE products ADD COLUMN source TEXT NOT NULL DEFAULT 'local'`);
      }
      if (!colExists(db, "products", "supplierSourceId")) {
        db.exec(`ALTER TABLE products ADD COLUMN supplierSourceId TEXT`);
      }
      if (!colExists(db, "products", "supplierProductId")) {
        db.exec(`ALTER TABLE products ADD COLUMN supplierProductId TEXT`);
      }
      if (!colExists(db, "products", "syncVersion")) {
        db.exec(`ALTER TABLE products ADD COLUMN syncVersion INTEGER`);
      }
      if (!colExists(db, "products", "lastSyncedAt")) {
        db.exec(`ALTER TABLE products ADD COLUMN lastSyncedAt TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_products_source ON products(source)`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplierSourceId, supplierProductId)`
      );
    }

    // ── supplierSources table (CREATE IF NOT EXISTS — idempotent) ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS supplierSources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        adapterType TEXT NOT NULL,
        authEnc TEXT,
        syncMode TEXT NOT NULL DEFAULT 'polling',
        syncIntervalSec INTEGER DEFAULT 3600,
        status TEXT NOT NULL DEFAULT 'active',
        lastSyncedAt TEXT,
        lastSyncError TEXT,
        syncVersion INTEGER DEFAULT 0,
        isActive INTEGER DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_supplier_status ON supplierSources(status)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_supplier_active ON supplierSources(isActive)`
    );
  },
};

export default migration;
