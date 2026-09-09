// Migration 019 — Story 2-38.2
// Multi-supplier product aggregation + auto-purchase fallback.
// Adds products.productGroupId, supplierOrders.purchaseLockExpiresAt,
// and supplierOrderAttempts table. Backfills productGroupId for existing
// external products based on normalized product name.
import { createHash } from "node:crypto";

function normalizeGroupId(name) {
  if (!name) return null;
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    // strip leading/trailing emoji and common punctuation
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!.:,;\-?_"'()]+/gu, "")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!.:,;\-?_"'()]+$/gu, "");
}

function hashGroupId(name) {
  const normalized = normalizeGroupId(name);
  if (!normalized) return null;
  return createHash("md5").update(normalized).digest("hex").slice(0, 16);
}

const migration = {
  version: 19,
  name: "product-groups",
  up(db) {
    // products.productGroupId
    const productCols = db.all(`PRAGMA table_info(products)`);
    if (!productCols.some((c) => c.name === "productGroupId")) {
      db.exec(`ALTER TABLE products ADD COLUMN productGroupId TEXT`);
    }

    // supplierOrders.purchaseLockExpiresAt
    const supplierOrderCols = db.all(`PRAGMA table_info(supplierOrders)`);
    if (!supplierOrderCols.some((c) => c.name === "purchaseLockExpiresAt")) {
      db.exec(`ALTER TABLE supplierOrders ADD COLUMN purchaseLockExpiresAt TEXT`);
    }

    // supplierOrderAttempts table
    db.exec(`
      CREATE TABLE IF NOT EXISTS supplierOrderAttempts (
        id TEXT PRIMARY KEY,
        orderId TEXT NOT NULL,
        supplierSourceId TEXT NOT NULL,
        supplierProductId TEXT,
        supplierPrice REAL,
        attemptIndex INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error TEXT,
        createdAt TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_supplier_attempts_order ON supplierOrderAttempts(orderId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_supplier_attempts_supplier ON supplierOrderAttempts(supplierSourceId)`);

    // Backfill productGroupId for existing external products where it is null.
    const rows = db.all(
      `SELECT id, name FROM products WHERE source = 'external_telegram_store' AND productGroupId IS NULL`
    );
    for (const { id, name } of rows) {
      const groupId = hashGroupId(name);
      if (groupId) {
        db.run(`UPDATE products SET productGroupId = ? WHERE id = ?`, [groupId, id]);
      }
    }
  },
};

export default migration;
