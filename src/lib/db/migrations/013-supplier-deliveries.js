// Migration 013: supplierDeliveries audit table (Story 2.33)
//
// Append-only delivery audit trail — metadata only, NO payload column (NFR8/D6).
// Backward-compat: purely additive (new table).

function tableExists(db, name) {
  return !!db.get(
    `SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name]
  );
}

const migration = {
  version: 13,
  name: "supplier-deliveries",
  up(db) {
    if (!tableExists(db, "supplierDeliveries")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS supplierDeliveries (
          id TEXT PRIMARY KEY,
          supplierOrderId TEXT NOT NULL,
          orderId TEXT NOT NULL,
          deliveryType TEXT,
          status TEXT NOT NULL,
          note TEXT,
          createdAt TEXT NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_supplier_delivery_order ON supplierDeliveries(orderId)`
      );
    }
  },
};

export default migration;
