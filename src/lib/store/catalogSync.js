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

export const EXTERNAL_SOURCE = "external_telegram_store";
// Default staleness threshold — external product not synced within this window is "stale"
// (catalog/checkout must not treat it as guaranteed in-stock, AC4/QĐ5).
export const DEFAULT_STALE_THRESHOLD_SEC = 24 * 3600;

/**
 * Upsert one normalized external product into products (dedup by supplierSourceId+supplierProductId).
 * Bumps syncVersion + stamps lastSyncedAt. Returns { inserted | updated }.
 * MUST run inside a caller-managed flow; uses its own statements (no local-product impact).
 */
function upsertExternalProduct(db, { sourceId, syncVersion, normalized, now }) {
  const existing = db.get(
    `SELECT id FROM products WHERE source = ? AND supplierSourceId = ? AND supplierProductId = ?`,
    [EXTERNAL_SOURCE, sourceId, normalized.supplierProductId]
  );
  if (existing) {
    db.run(
      `UPDATE products SET name=?, description=?, priceCredits=?, stock=?,
         syncVersion=?, lastSyncedAt=?, updatedAt=? WHERE id=?`,
      [
        normalized.name,
        normalized.description ?? null,
        Number(normalized.priceCredits ?? 0),
        normalized.stock ?? null,
        syncVersion,
        now,
        now,
        existing.id,
      ]
    );
    return { id: existing.id, action: "updated" };
  }
  const id = uuidv4();
  db.run(
    `INSERT INTO products(id, kind, name, description, priceCredits, deliveryMode,
       targetType, targetId, stock, isActive, source, supplierSourceId, supplierProductId,
       syncVersion, lastSyncedAt, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "service",                         // external products default kind (markup/publish = 2.31)
      normalized.name,
      normalized.description ?? null,
      Number(normalized.priceCredits ?? 0),
      "admin_fulfill",                   // external delivery handled in 2.32+; not sellable yet (QĐ7)
      null,
      null,
      normalized.stock ?? null,
      0,                                 // isActive=0 until 2.31 publishing (QĐ7 gate)
      EXTERNAL_SOURCE,
      sourceId,
      normalized.supplierProductId,
      syncVersion,
      now,
      now,
      now,
    ]
  );
  return { id, action: "inserted" };
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
