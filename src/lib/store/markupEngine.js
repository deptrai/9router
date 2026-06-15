// Story 2.31 — Markup engine: retail price calculation + product publish/unpublish.
// Pure calculation layer (calculateRetailPrice) is DB-free for easy unit testing.
// All DB operations use the optional `db` adapter pattern (E7) to allow inline
// calls from within an already-open transaction (e.g. upsertExternalProduct).
import { getAdapter } from "../db/driver.js";
import { findApplicableRule } from "../db/repos/markupRulesRepo.js";

// Minimum decimal precision for float results — mitigates BP-6 drift
// (e.g. 14.999999999999998 → 15). Applied even when roundingRule='none'.
const PRECISION = 1e6;

// Story 2.31: external product source marker. Defined locally (mirrors productsRepo.js)
// to keep the publish/unpublish guard self-contained without a cross-layer import.
const EXTERNAL_SOURCE = "external_telegram_store";

/**
 * Pure function — no DB, no side effects.
 * Calculates retail price from supplier price + markup percentage + rounding rule.
 *
 * @param {number} supplierPrice
 * @param {number} markupPct  — must be > 0 (0 or negative → throw)
 * @param {'none'|'ceil'|'floor'|'round'} roundingRule
 * @returns {number} retailPrice
 */
export function calculateRetailPrice(supplierPrice, markupPct, roundingRule = "none") {
  if (typeof supplierPrice !== "number" || !Number.isFinite(supplierPrice) || supplierPrice < 0) {
    throw new Error("calculateRetailPrice: supplierPrice phải là số hữu hạn không âm");
  }
  // QĐ8: markupPct <= 0 → reject (retailPrice <= supplierPrice ⟺ markupPct <= 0 với supplierPrice dương)
  // Review patch (MAJOR): !Number.isFinite cũng bắt Infinity/NaN — Infinity <= 0 = false nên lọt
  // qua check cũ, gây retailPrice=Infinity → priceCredits=Infinity → checkout vỡ vĩnh viễn.
  if (typeof markupPct !== "number" || !Number.isFinite(markupPct) || markupPct <= 0) {
    throw new Error("calculateRetailPrice: markupPct phải lớn hơn 0 (margin dương bắt buộc)");
  }

  const raw = supplierPrice * (1 + markupPct / 100);

  // BP-6: always round to at least 6 decimal places regardless of roundingRule
  switch (roundingRule) {
    case "ceil":  return Math.ceil(raw);
    case "floor": return Math.floor(raw);
    case "round": return Math.round(raw);
    case "none":
    default:
      return Math.round(raw * PRECISION) / PRECISION;
  }
}

/**
 * Core sync worker (E7 pattern, mirrors recordCreditTxnWithAdapter):
 * looks up the applicable markup rule, computes retailPrice/expectedMargin,
 * and persists them + priceCredits onto the products row.
 *
 * @param {string} productId
 * @param {object} adapter           — DB adapter
 * @param {boolean} wrapTransaction  — true: own the transaction; false: run inline
 *                                     (caller already owns one — kept synchronous so a
 *                                      thrown DB error aborts the outer transaction).
 * @returns {{ retailPrice, expectedMargin } | null}  null if no applicable rule found
 */
function applyMarkupWithAdapter(productId, adapter, wrapTransaction) {
  let result = null;

  const doWork = () => {
    const product = adapter.get(`SELECT * FROM products WHERE id = ?`, [productId]);
    if (!product) throw new Error(`applyMarkupToProduct: product ${productId} not found`);
    if (product.supplierPrice == null) {
      throw new Error(`applyMarkupToProduct: product ${productId} has no supplierPrice`);
    }

    const rule = findApplicableRule(adapter, productId, product.supplierSourceId);
    if (!rule) return; // no rule — leave priceCredits untouched, caller decides

    const retailPrice = calculateRetailPrice(product.supplierPrice, rule.markupPct, rule.roundingRule);
    const expectedMargin = Math.round((retailPrice - product.supplierPrice) * PRECISION) / PRECISION;

    adapter.run(
      `UPDATE products SET retailPrice=?, expectedMargin=?, priceCredits=?, updatedAt=? WHERE id=?`,
      [retailPrice, expectedMargin, retailPrice, new Date().toISOString(), productId]
    );

    result = { retailPrice, expectedMargin };
  };

  if (wrapTransaction) {
    adapter.transaction(doWork);
  } else {
    // Caller already owns a transaction — run inline (synchronous) so DB errors
    // abort the outer transaction (QĐ4: lookup + UPDATE atomic, no nested txn).
    doWork();
  }

  return result;
}

/**
 * Look up the applicable markup rule for a product, compute retailPrice/expectedMargin,
 * and persist them + priceCredits onto the products row.
 *
 * E7 dual-mode (mirrors recordCreditTxn):
 * - `db` provided → caller already owns a transaction; runs INLINE + SYNCHRONOUS so a
 *   thrown DB error aborts the outer transaction. Returns the result object directly.
 * - `db` omitted → opens its own transaction; returns a Promise.
 *
 * @param {string} productId
 * @param {object} [db]  — optional DB adapter (pass when already inside a transaction)
 * @returns {{ retailPrice, expectedMargin } | null | Promise<...>}
 */
export function applyMarkupToProduct(productId, db = null) {
  if (db) {
    return applyMarkupWithAdapter(productId, db, false);
  }
  return (async () => {
    const adapter = await getAdapter();
    return applyMarkupWithAdapter(productId, adapter, true);
  })();
}

/**
 * Publish an external product — validates pricing is set, then sets
 * isPublished=1 AND isActive=1 (invariant: isPublished=1 ⇒ isActive=1).
 *
 * @param {string} productId
 */
export async function publishProduct(productId) {
  const db = await getAdapter();
  db.transaction(() => {
    const product = db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
    if (!product) throw new Error(`publishProduct: product ${productId} not found`);
    if (product.supplierPrice == null) {
      throw new Error("publishProduct: supplierPrice chưa được set — cần sync trước");
    }
    if (product.retailPrice == null || product.retailPrice <= 0) {
      throw new Error("publishProduct: retailPrice chưa được set hoặc <= 0 — cần applyMarkupToProduct trước");
    }
    db.run(
      `UPDATE products SET isPublished=1, isActive=1, updatedAt=? WHERE id=?`,
      [new Date().toISOString(), productId]
    );
  });
}

/**
 * Unpublish an external product — sets isPublished=0 AND isActive=0.
 * This is the "admin lock": sync will never re-activate a product locked this way.
 *
 * @param {string} productId
 */
export async function unpublishProduct(productId) {
  const db = await getAdapter();
  db.transaction(() => {
    const product = db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
    if (!product) throw new Error(`unpublishProduct: product ${productId} not found`);
    // Review patch (MAJOR): guard against deactivating LOCAL products. publishProduct is
    // implicitly guarded by the supplierPrice==null check, but unpublishProduct had no
    // equivalent — calling it on a local product would set isActive=0 and drop it from the
    // catalog (AC5 backward-compat violation). Local visibility is managed via updateProduct.
    if (product.source !== EXTERNAL_SOURCE) {
      throw new Error(
        "unpublishProduct: chỉ external product mới unpublish được — local product dùng updateProduct"
      );
    }
    db.run(
      `UPDATE products SET isPublished=0, isActive=0, updatedAt=? WHERE id=?`,
      [new Date().toISOString(), productId]
    );
  });
}

/**
 * Safe price for catalog display — prefers retailPrice (markup applied),
 * falls back to priceCredits (raw supplier price for unpriced products).
 *
 * @param {object} product
 * @returns {number}
 */
export function getEffectivePrice(product) {
  return product.retailPrice ?? product.priceCredits;
}
