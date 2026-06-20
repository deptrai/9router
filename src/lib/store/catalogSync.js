// Story 2.30 — catalogSync: sync external supplier catalog into products table.
// Upserts external products (source='external_telegram_store'), dedup by
// (supplierSourceId, supplierProductId). NEVER touches local products (source='local').
// Fail-soft: adapter errors → recordSyncFailure (degraded/unhealthy), never throw to crash a job.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../db/driver.js";
import { getAdapter as getSupplierAdapter } from "./suppliers/index.js";
import {
  getSupplierSourceWithAuth,
  recordSyncSuccess,
  recordSyncFailure,
  listPollableSources,
} from "../db/repos/supplierSourcesRepo.js";
import { findApplicableRule } from "../db/repos/markupRulesRepo.js";
import { applyMarkupToProduct } from "./markupEngine.js";

export const EXTERNAL_SOURCE = "external_telegram_store";
// Default staleness threshold — external product not synced within this window is "stale"
// (catalog/checkout must not treat it as guaranteed in-stock, AC4/QĐ5).
export const DEFAULT_STALE_THRESHOLD_SEC = 24 * 3600;

/**
 * Upsert one normalized external product into products (dedup by supplierSourceId+supplierProductId).
 * Bumps syncVersion + stamps lastSyncedAt. Returns { id, action: "inserted"|"updated" }.
 *
 * QĐ6 invariants (2.31):
 * - UPDATE path: only writes supplierPrice + name/description/stock/syncVersion/lastSyncedAt.
 *   NEVER writes priceCredits directly — priceCredits is ONLY set by applyMarkupToProduct.
 *   NEVER writes isActive or isPublished — publish state is admin-only truth.
 * - INSERT path: sets priceCredits = supplierPrice as safe initial default (priceCredits is
 *   NOT NULL; leaving it 0 would allow checkout to charge 0 before markup is applied).
 * - After write: if a markup rule applies, calls applyMarkupToProduct(id, db) inline within
 *   the SAME transaction (pass db adapter — do NOT open a nested transaction, pattern E7).
 *
 * MUST be called from within a caller-managed db.transaction().
 */
function upsertExternalProduct(db, { sourceId, syncVersion, normalized, now }) {
  // Review patch (MAJOR): coerce defensively — Number("abc")=NaN slips past `?? 0`
  // (which only guards null/undefined). NaN bound to a REAL column would silently store
  // NULL, breaking publishProduct/applyMarkupToProduct later. Clamp non-finite to 0.
  const rawPrice = Number(normalized.priceCredits ?? 0);
  const supplierPrice = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;

  const existing = db.get(
    `SELECT id, supplierSourceId, isPublished FROM products WHERE source = ? AND supplierSourceId = ? AND supplierProductId = ?`,
    [EXTERNAL_SOURCE, sourceId, normalized.supplierProductId]
  );

  let productId;
  if (existing) {
    const isPublished = existing.isPublished === 1 || existing.isPublished === true;
    if (isPublished) {
      // Published/approved product: do NOT overwrite custom name & description, only update supplierPrice/stock
      db.run(
        `UPDATE products SET supplierPrice=?, stock=?,
           syncVersion=?, lastSyncedAt=?, updatedAt=? WHERE id=?`,
        [
          supplierPrice,
          normalized.stock ?? null,
          syncVersion,
          now,
          now,
          existing.id,
        ]
      );
    } else {
      // Draft/unpublished product: update name/description from source
      db.run(
        `UPDATE products SET name=?, description=?, supplierPrice=?, stock=?,
           syncVersion=?, lastSyncedAt=?, updatedAt=? WHERE id=?`,
        [
          normalized.name,
          normalized.description ?? null,
          supplierPrice,
          normalized.stock ?? null,
          syncVersion,
          now,
          now,
          existing.id,
        ]
      );
    }
    productId = existing.id;

    // Re-apply markup inline if a rule exists (keeps priceCredits = retailPrice atomic).
    const rule = findApplicableRule(db, productId, sourceId);
    if (rule) {
      applyMarkupToProduct(productId, db);
    }

    return { id: productId, action: "updated" };
  }

  // INSERT path: set priceCredits = supplierPrice as initial default (non-zero safe default).
  // applyMarkupToProduct will overwrite priceCredits once a rule is set (QĐ6).
  productId = uuidv4();
  db.run(
    `INSERT INTO products(id, kind, name, description, priceCredits, deliveryMode,
       targetType, targetId, stock, isActive, isPublished, source, supplierSourceId,
       supplierProductId, supplierPrice, syncVersion, lastSyncedAt, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      productId,
      "service",
      normalized.name,
      normalized.description ?? null,
      supplierPrice,              // priceCredits = supplierPrice (safe initial default)
      "admin_fulfill",
      null,
      null,
      normalized.stock ?? null,
      0,                          // isActive=0 until admin publishes (QĐ7/QĐ9 gate)
      0,                          // isPublished=0 — admin explicit publish required
      EXTERNAL_SOURCE,
      sourceId,
      normalized.supplierProductId,
      supplierPrice,              // supplierPrice stored separately
      syncVersion,
      now,
      now,
      now,
    ]
  );

  // Apply markup inline if a rule already exists for this supplier/product.
  const rule = findApplicableRule(db, productId, sourceId);
  if (rule) {
    applyMarkupToProduct(productId, db);
  }

  return { id: productId, action: "inserted" };
}

/**
 * Sync a full catalog from a source (AC4 polling path). Fail-soft (AC5).
 * Returns { ok, inserted, updated, error? }.
 */
export async function syncSource(sourceId) {
  const source = await getSupplierSourceWithAuth(sourceId);
  if (!source) return { ok: false, error: "source not found" };
  if (source.status === "unsupported") {
    return { ok: false, error: "source is unsupported" };
  }

  // Webhook adapters are push-only — a pull/poll sync is a no-op, NOT a fault. Return
  // early without degrading health (T8: avoids spurious degraded/unhealthy on manual
  // ?action=sync or a mis-classified poll of a webhook source).
  if (source.adapterType === "webhook") {
    return { ok: false, skipped: true, error: "webhook source is push-only; nothing to sync" };
  }
  // Decrypt failure → empty creds. Fail clearly with the real cause instead of letting the
  // adapter fetch with no credentials and mis-diagnose as a transient supplier fault (T5).
  if (source.authError) {
    await recordSyncFailure(sourceId, source.authError);
    return { ok: false, error: source.authError };
  }

  let adapter;
  try {
    adapter = getSupplierAdapter(source.adapterType);
  } catch (err) {
    await recordSyncFailure(sourceId, err.message);
    return { ok: false, error: err.message };
  }

  const result = await adapter.fetchCatalog(source, source.auth);
  if (result.error) {
    await recordSyncFailure(sourceId, result.error);
    return { ok: false, error: result.error };
  }

  const nextVersion = (source.syncVersion ?? 0) + 1;
  const now = new Date().toISOString();
  const db = await getAdapter();
  let inserted = 0, updated = 0;
  try {
    db.transaction(() => {
      for (const raw of result.products) {
        const normalized = adapter.normalizeProduct(raw);
        if (!normalized.supplierProductId) continue; // skip un-dedupable rows
        const r = upsertExternalProduct(db, { sourceId, syncVersion: nextVersion, normalized, now });
        if (r.action === "inserted") inserted++; else updated++;
      }
    });
  } catch (err) {
    await recordSyncFailure(sourceId, err.message);
    return { ok: false, error: err.message };
  }

  await recordSyncSuccess(sourceId, { syncVersion: nextVersion });
  return { ok: true, inserted, updated, syncVersion: nextVersion };
}

/**
 * Apply a single webhook push event (AC3) — update/insert one external product.
 * event: { supplierProductId, name?, priceCredits?, stock?, isActive?, description? }
 */
export async function applyWebhookEvent(sourceId, event) {
  const source = await getSupplierSourceWithAuth(sourceId);
  if (!source) return { ok: false, error: "source not found" };
  if (source.status === "unsupported") return { ok: false, error: "source is unsupported" };

  let adapter;
  try {
    adapter = getSupplierAdapter(source.adapterType);
  } catch (err) {
    await recordSyncFailure(sourceId, err.message);
    return { ok: false, error: err.message };
  }

  const normalized = adapter.normalizeProduct(event);
  if (!normalized.supplierProductId) {
    return { ok: false, error: "event missing supplierProductId" };
  }
  const nextVersion = (source.syncVersion ?? 0) + 1;
  const now = new Date().toISOString();
  const db = await getAdapter();
  let action;
  try {
    db.transaction(() => {
      action = upsertExternalProduct(db, { sourceId, syncVersion: nextVersion, normalized, now }).action;
    });
  } catch (err) {
    await recordSyncFailure(sourceId, err.message);
    return { ok: false, error: err.message };
  }
  await recordSyncSuccess(sourceId, { syncVersion: nextVersion });
  return { ok: true, action, syncVersion: nextVersion };
}

/**
 * Stale guard (AC4) — external product not synced within thresholdSec is stale.
 * Local products are NEVER stale (no lastSyncedAt dependency).
 */
export function isProductStale(product, thresholdSec = DEFAULT_STALE_THRESHOLD_SEC) {
  if (!product || product.source !== EXTERNAL_SOURCE) return false;
  if (!product.lastSyncedAt) return true; // external but never synced → stale
  // Guard thresholdSec<=0 (would mark every just-synced product stale immediately) — fall
  // back to the default window (T11).
  const threshold = thresholdSec > 0 ? thresholdSec : DEFAULT_STALE_THRESHOLD_SEC;
  return Date.now() - new Date(product.lastSyncedAt).getTime() > threshold * 1000;
}

/**
 * Polling driver (AC4/T5) — sync every polling source whose interval has elapsed.
 * Fail-soft per source (one source's failure never blocks others). Intended to be
 * invoked by a cron/manual trigger — does NOT self-schedule (no MVP cron infra yet).
 * Returns a per-source result summary.
 */
export async function runDuePolls() {
  const due = await listPollableSources();
  const results = [];
  for (const src of due) {
    try {
      const r = await syncSource(src.id);
      results.push({ sourceId: src.id, ...r });
    } catch (err) {
      // syncSource already records failures internally; guard belt-and-suspenders.
      results.push({ sourceId: src.id, ok: false, error: err?.message || "poll failed" });
    }
  }
  return { polled: due.length, results };
}
