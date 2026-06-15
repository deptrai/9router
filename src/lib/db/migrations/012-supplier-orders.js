// Migration 012: supplierOrders table + paymentMode columns (Story 2.32)
//
// Backward-compat: all changes are additive.
// - supplierSources.paymentMode DEFAULT 'proxy_checkout' — existing rows get default on ALTER.
// - products.paymentModeOverride nullable — local products remain null, no behaviour change.
// - supplierOrders table is new — no existing rows affected.

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
  version: 12,
  name: "supplier-orders",
  up(db) {
    // ── supplierSources: add paymentMode column ──
    if (tableExists(db, "supplierSources")) {
      if (!colExists(db, "supplierSources", "paymentMode")) {
        db.exec(
          `ALTER TABLE supplierSources ADD COLUMN paymentMode TEXT NOT NULL DEFAULT 'proxy_checkout'`
        );
      }
    }

    // ── products: add paymentModeOverride column (nullable, backward-compat) ──
    if (tableExists(db, "products")) {
      if (!colExists(db, "products", "paymentModeOverride")) {
        db.exec(`ALTER TABLE products ADD COLUMN paymentModeOverride TEXT`);
      }
    }

    // ── supplierOrders table (CREATE IF NOT EXISTS — idempotent) ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS supplierOrders (
        id TEXT PRIMARY KEY,
        orderId TEXT NOT NULL,
        supplierSourceId TEXT NOT NULL,
        supplierProductId TEXT,
        paymentMode TEXT NOT NULL,
        supplierOrderId TEXT,
        supplierInvoiceId TEXT,
        qrPayload TEXT,
        supplierPrice REAL,
        retailPrice REAL,
        expectedMargin REAL,
        supplierStatus TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_supplier_order_order ON supplierOrders(orderId)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_supplier_order_source ON supplierOrders(supplierSourceId)`
    );
  },
};

export default migration;
