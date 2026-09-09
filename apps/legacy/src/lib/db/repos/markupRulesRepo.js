import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// Enum tập trung (pattern E8) — tránh magic strings
export const ROUNDING_RULES = ["none", "ceil", "floor", "round"];

function rowToRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    supplierId: row.supplierId ?? null,
    productId: row.productId ?? null,
    markupPct: row.markupPct,
    roundingRule: row.roundingRule ?? "none",
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateRuleData(data) {
  // Review patch (MAJOR): !Number.isFinite bắt cả Infinity/NaN — Infinity <= 0 = false nên
  // lọt qua check cũ → markupPct=Infinity ghi vào DB → retailPrice/priceCredits=Infinity.
  if (typeof data.markupPct !== "number" || !Number.isFinite(data.markupPct)) {
    throw new Error("markupPct phải là số hữu hạn");
  }
  if (data.markupPct <= 0) {
    throw new Error("markupPct phải lớn hơn 0 (margin dương bắt buộc)");
  }
  if (data.roundingRule !== undefined && !ROUNDING_RULES.includes(data.roundingRule)) {
    throw new Error(`roundingRule phải là một trong [${ROUNDING_RULES.join(", ")}]`);
  }
  // Scope: global (both supplierId+productId null), supplier-level, or product-level
  // are ALL valid — no scope restriction needed.
}

/**
 * Create a markup rule.
 * At least one scope (supplierId, productId) should be provided, or both null for global.
 */
export async function createMarkupRule(data) {
  validateRuleData(data);
  const db = await getAdapter();
  const id = uuidv4();
  const now = new Date().toISOString();
  const supplierId = data.supplierId ?? null;
  const productId = data.productId ?? null;
  const roundingRule = data.roundingRule ?? "none";
  const isActive = data.isActive !== false ? 1 : 0;

  db.run(
    `INSERT INTO markupRules(id, supplierId, productId, markupPct, roundingRule, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, supplierId, productId, data.markupPct, roundingRule, isActive, now, now]
  );
  return rowToRule({ id, supplierId, productId, markupPct: data.markupPct, roundingRule, isActive, createdAt: now, updatedAt: now });
}

export async function listMarkupRules() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM markupRules ORDER BY createdAt DESC`).map(rowToRule);
}

export async function getMarkupRuleById(id) {
  const db = await getAdapter();
  return rowToRule(db.get(`SELECT * FROM markupRules WHERE id = ?`, [id]));
}

export async function updateMarkupRule(id, data) {
  if (!id) throw new Error("updateMarkupRule: id là bắt buộc");
  const db = await getAdapter();
  const existing = db.get(`SELECT * FROM markupRules WHERE id = ?`, [id]);
  if (!existing) throw new Error("updateMarkupRule: không tìm thấy rule");

  if (data.markupPct !== undefined) {
    validateRuleData({ ...data });
  } else if (data.roundingRule !== undefined) {
    if (!ROUNDING_RULES.includes(data.roundingRule)) {
      throw new Error(`roundingRule phải là một trong [${ROUNDING_RULES.join(", ")}]`);
    }
  }

  const fields = [];
  const values = [];

  if (data.supplierId !== undefined) { fields.push("supplierId = ?"); values.push(data.supplierId ?? null); }
  if (data.productId !== undefined) { fields.push("productId = ?"); values.push(data.productId ?? null); }
  if (data.markupPct !== undefined) { fields.push("markupPct = ?"); values.push(data.markupPct); }
  if (data.roundingRule !== undefined) { fields.push("roundingRule = ?"); values.push(data.roundingRule); }
  if (data.isActive !== undefined) { fields.push("isActive = ?"); values.push(data.isActive !== false ? 1 : 0); }

  if (!fields.length) return rowToRule(existing);

  const now = new Date().toISOString();
  fields.push("updatedAt = ?");
  values.push(now);
  values.push(id);

  db.run(`UPDATE markupRules SET ${fields.join(", ")} WHERE id = ?`, values);
  return rowToRule(db.get(`SELECT * FROM markupRules WHERE id = ?`, [id]));
}

export async function deleteMarkupRule(id) {
  if (!id) throw new Error("deleteMarkupRule: id là bắt buộc");
  const db = await getAdapter();
  const existing = db.get(`SELECT * FROM markupRules WHERE id = ?`, [id]);
  if (!existing) throw new Error("deleteMarkupRule: không tìm thấy rule");
  db.run(`DELETE FROM markupRules WHERE id = ?`, [id]);
  return { deleted: true, id };
}

/**
 * Find applicable markup rule for a product+supplier combo.
 * Priority: product-level → supplier-level → global.
 * Returns first matching active rule, or null if none.
 * Tier `category` bị bỏ — products không có cột category để bind.
 */
export function findApplicableRule(db, productId, supplierId) {
  // Review patch (MINOR): ORDER BY createdAt ASC makes LIMIT 1 deterministic — without it
  // SQLite returns rows in B-tree/rowid order, which shifts after VACUUM/checkpoint and lets
  // the applied markup change with no admin action when >1 active rule exists per tier.
  // "Oldest rule wins" within a tier (stable, predictable).
  // product-level
  if (productId) {
    const rule = db.get(
      `SELECT * FROM markupRules WHERE productId = ? AND isActive = 1 ORDER BY createdAt ASC LIMIT 1`,
      [productId]
    );
    if (rule) return rowToRule(rule);
  }
  // supplier-level
  if (supplierId) {
    const rule = db.get(
      `SELECT * FROM markupRules WHERE supplierId = ? AND productId IS NULL AND isActive = 1 ORDER BY createdAt ASC LIMIT 1`,
      [supplierId]
    );
    if (rule) return rowToRule(rule);
  }
  // global
  const rule = db.get(
    `SELECT * FROM markupRules WHERE supplierId IS NULL AND productId IS NULL AND isActive = 1 ORDER BY createdAt ASC LIMIT 1`
  );
  return rule ? rowToRule(rule) : null;
}
