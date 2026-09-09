// Migration 008: entitlements table + providerConnections owner/entitlement cols (Story 2.29a)
//
// Backward-compat (M1, F7): the two new providerConnections columns are added as
// nullable with NO non-null default — legacy connections keep ownerUserId=NULL and
// remain in the shared admin routing pool, so getProviderConnections/
// getProviderCredentials behaviour is unchanged.
//
// Tables/columns also ship in the declarative TABLES schema; syncSchemaFromTables()
// runs AFTER versioned migrations and would create them on brand-new DBs. This
// migration handles EXISTING DBs (guarded by tableExists / column presence) so the
// ALTER never throws "no such table" and wedges the app at the prior schemaVersion.
function tableExists(db, name) {
  return !!db.get(
    `SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name]
  );
}

const migration = {
  version: 8,
  name: "entitlements",
  up(db) {
    // ── providerConnections: add ownerUserId + entitlementId (nullable) ──
    if (tableExists(db, "providerConnections")) {
      const cols = new Set(
        db.all(`PRAGMA table_info(providerConnections)`).map((r) => r.name)
      );
      if (!cols.has("ownerUserId")) {
        db.exec(`ALTER TABLE providerConnections ADD COLUMN ownerUserId TEXT`);
      }
      if (!cols.has("entitlementId")) {
        db.exec(`ALTER TABLE providerConnections ADD COLUMN entitlementId TEXT`);
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_pc_owner ON providerConnections(ownerUserId)`
      );
    }

    // ── entitlements table (CREATE IF NOT EXISTS — idempotent) ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS entitlements (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        productId TEXT NOT NULL,
        provider TEXT,
        status TEXT NOT NULL DEFAULT 'pending_connection',
        providerConnectionId TEXT,
        routePolicy TEXT NOT NULL DEFAULT 'prefer_owned',
        expiresAt TEXT,
        note TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements(userId, status)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_entitlements_product ON entitlements(productId)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_entitlements_status ON entitlements(status)`
    );
  },
};

export default migration;
