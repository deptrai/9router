// Story 2.30 — supplierSourcesRepo: external supplier source CRUD + health lifecycle.
// Auth credentials encrypted at rest (STORE_ENC_KEY, reuse 2.27 secretBox).
// API NEVER returns authEnc/plaintext — list/get mask to { hasAuth: boolean } (QĐ8).
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { encrypt, decrypt } from "../../crypto/secretBox.js";
import { getAdapter as getSupplierAdapter } from "../../store/suppliers/index.js";

// Enum tập trung (E8) — single source of truth, import thay vì hardcode string.
export const ADAPTER_TYPES = ["supplier_api", "channel_feed", "polling_feed", "webhook", "telegram_bot_scraper"];
export const SYNC_MODES = ["webhook", "polling"];
export const SOURCE_STATUSES = ["active", "degraded", "unhealthy", "unsupported"];

// Min polling interval — chặn syncIntervalSec=0/âm hammer supplier ở full rate (edge-case guard).
export const MIN_SYNC_INTERVAL_SEC = 60;

// Reported instead of a misleading "invalid config" when authEnc cannot be decrypted.
const AUTH_DECRYPT_ERROR = "auth credentials could not be decrypted (corrupted or key mismatch) — re-enter the source credentials to recover";

/**
 * Normalize syncIntervalSec to the generic floor. Adapter-specific minimums (e.g.
 * telegram_bot_scraper requires >= 3600) are enforced separately via adapter.validate(),
 * which must REJECT rather than clamp (AC7/QĐ6).
 *
 * Number.isFinite rejects NaN AND Infinity: `Math.max(60, Infinity)` used to survive and
 * produce a source whose next poll is never due, i.e. a silently dead source.
 */
function resolveSyncInterval(value, fallback, caller) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${caller}: syncIntervalSec must be a finite number, got ${String(value)}`);
  }
  return Math.max(MIN_SYNC_INTERVAL_SEC, Math.floor(parsed) || 0);
}

// External product source marker. Defined locally (NOT imported from catalogSync.js) to keep
// the db-layer repo free of store-layer deps and avoid a circular import
// (catalogSync → markupEngine → markupRulesRepo). Mirrors productsRepo.js (story 2.31).
const EXTERNAL_SOURCE = "external_telegram_store";

// Health lifecycle (QĐ6): active → degraded (1st fail) → unhealthy (2nd+ consecutive fail).
// Any sync success resets to active.
const STATUS = Object.freeze({
  ACTIVE: "active",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
  UNSUPPORTED: "unsupported",
});

/**
 * Public mapper — masks auth (NEVER exposes authEnc/plaintext, QĐ8/AC1).
 */
function maskSource(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType,
    syncMode: row.syncMode,
    syncIntervalSec: row.syncIntervalSec ?? null,
    status: row.status,
    hasAuth: !!row.authEnc,
    lastSyncedAt: row.lastSyncedAt ?? null,
    lastSyncError: row.lastSyncError ?? null,
    syncVersion: row.syncVersion ?? 0,
    isActive: row.isActive === 1 || row.isActive === true,
    paymentMode: row.paymentMode ?? "proxy_checkout",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create supplier source — validate adapterType + config via adapter, encrypt auth (AC1/AC2).
 * If adapter.validate() returns `unsupported`, source is created with status='unsupported'
 * + reason in lastSyncError (admin sees why) instead of being rejected outright (AC2).
 * Hard validation errors (missing required config) throw.
 */
export async function createSupplierSource(data) {
  if (!data || typeof data !== "object") {
    throw new Error("createSupplierSource: data object required");
  }
  if (!data.name) throw new Error("createSupplierSource: name required");
  if (!ADAPTER_TYPES.includes(data.adapterType)) {
    throw new Error(`createSupplierSource: adapterType must be one of [${ADAPTER_TYPES.join(", ")}]`);
  }
  const syncMode = data.syncMode || "polling";
  if (!SYNC_MODES.includes(syncMode)) {
    throw new Error(`createSupplierSource: syncMode must be one of [${SYNC_MODES.join(", ")}]`);
  }
  // Min-interval guard — syncIntervalSec=0/âm sẽ làm runDuePolls hammer supplier ở full rate.
  const syncIntervalSec = resolveSyncInterval(data.syncIntervalSec, 3600, "createSupplierSource");

  const adapter = getSupplierAdapter(data.adapterType);
  const auth = data.auth || {};
  // Pass the resolved syncIntervalSec into validate() so adapters with a stricter minimum
  // (AC7/QĐ6) can reject before anything is written — validate() must throw, not clamp.
  const validation = adapter.validate({ ...auth, syncIntervalSec });
  // Hard reject only for non-unsupported config errors (AC1). `unsupported` → create + flag (AC2).
  if (!validation.ok && !validation.unsupported) {
    throw new Error(`createSupplierSource: invalid config — ${validation.reason}`);
  }

  const authEnc = Object.keys(auth).length > 0 ? encrypt(JSON.stringify(auth)) : null;
  const now = new Date().toISOString();
  const db = await getAdapter();
  const source = {
    id: data.id || uuidv4(),
    name: data.name,
    adapterType: data.adapterType,
    authEnc,
    syncMode,
    syncIntervalSec,
    status: validation.unsupported ? STATUS.UNSUPPORTED : STATUS.ACTIVE,
    lastSyncedAt: null,
    lastSyncError: validation.unsupported ? validation.reason : null,
    syncVersion: 0,
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO supplierSources(id, name, adapterType, authEnc, syncMode, syncIntervalSec, status, lastSyncedAt, lastSyncError, syncVersion, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [source.id, source.name, source.adapterType, source.authEnc, source.syncMode,
     source.syncIntervalSec, source.status, source.lastSyncedAt, source.lastSyncError,
     source.syncVersion, source.isActive, source.createdAt, source.updatedAt]
  );
  return maskSource(source);
}

export async function listSupplierSources() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM supplierSources ORDER BY createdAt DESC`);
  return rows.map(maskSource);
}

export async function getSupplierSourceById(id) {
  const db = await getAdapter();
  return maskSource(db.get(`SELECT * FROM supplierSources WHERE id = ?`, [id]));
}

/**
 * Internal/trusted: returns source WITH decrypted auth for catalogSync adapter calls.
 * NEVER expose via API — only catalogSync/polling use this.
 */
export async function getSupplierSourceWithAuth(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM supplierSources WHERE id = ?`, [id]);
  if (!row) return null;
  let auth = {};
  let authError = null;
  if (row.authEnc) {
    try {
      auth = JSON.parse(decrypt(row.authEnc));
    } catch {
      // Decrypt failed (corrupted blob / key rotation). Signal it so callers don't
      // silently sync with empty creds and mis-diagnose as a transient supplier fault (T5).
      auth = {};
      authError = "auth credentials could not be decrypted (corrupted or key mismatch)";
    }
  }
  return { ...maskSource(row), auth, authError, syncVersion: row.syncVersion ?? 0 };
}

export async function updateSupplierSource(id, patch = {}) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM supplierSources WHERE id = ?`, [id]);
  if (!row) return null;
  // Validate BEFORE building next (guard order: reject invalid enum before any write path).
  if (patch.syncMode && !SYNC_MODES.includes(patch.syncMode)) {
    throw new Error(`updateSupplierSource: syncMode must be one of [${SYNC_MODES.join(", ")}]`);
  }
  const nextSyncIntervalSec = resolveSyncInterval(
    patch.syncIntervalSec, row.syncIntervalSec, "updateSupplierSource",
  );

  // Re-validate via adapter on EVERY update (AC1/QĐ4/AC7) — not only when patch.auth is
  // supplied. Course correction: a syncIntervalSec-only patch must still be checked against
  // adapter-specific minimums (e.g. telegram_bot_scraper requires >= 3600), otherwise AC7
  // is bypassed by omitting auth from the patch.
  let nextStatus = row.status;
  let nextLastError = row.lastSyncError;
  const adapter = getSupplierAdapter(row.adapterType);
  // `auth: null` clears the credentials; `auth: {...}` merges; omitting it leaves them alone.
  const clearAuth = patch.auth === null;
  const hasAuthPatch = !clearAuth && patch.auth && typeof patch.auth === "object";

  let existingAuth = {};
  let authUnreadable = false;
  if (row.authEnc) {
    try {
      existingAuth = JSON.parse(decrypt(row.authEnc));
    } catch {
      // Corrupted blob / rotated STORE_ENC_KEY. Do NOT silently fall back to {} and let
      // validate() fail: that reported "invalid config" for what is really a decryption
      // failure, and since validate() now runs on EVERY update it also made the row
      // impossible to rename or disable — removing the operator's only way to stop the
      // bleeding on a broken source.
      authUnreadable = true;
    }
  }

  // MERGE, don't replace (code review 2026-07-28, D4). maskSource never returns auth, so a
  // client cannot read the current credentials back in order to re-send them in full;
  // replace semantics silently dropped whatever the caller omitted (e.g. losing relayUrl and
  // interactionSteps while changing only vndPerCredit).
  const mergedAuth = hasAuthPatch
    ? { ...(authUnreadable ? {} : existingAuth), ...patch.auth }
    : existingAuth;

  if (authUnreadable && !hasAuthPatch) {
    // Nothing validatable. Let operational patches (name / isActive / syncMode / interval)
    // through so the source can be renamed or switched off, and surface the real cause.
    nextLastError = AUTH_DECRYPT_ERROR;
  } else {
    const validation = adapter.validate({ ...mergedAuth, syncIntervalSec: nextSyncIntervalSec });
    if (!validation.ok && !validation.unsupported) {
      throw new Error(`updateSupplierSource: invalid config — ${validation.reason}`);
    }
    // Unsupported config → flag source (AC2) instead of silently accepting.
    if (validation.unsupported) {
      nextStatus = STATUS.UNSUPPORTED;
      nextLastError = validation.reason;
    } else if (row.status === STATUS.UNSUPPORTED && hasAuthPatch) {
      // Heal out of `unsupported` only on a real config change. That status is deliberately
      // sticky against sync/enable events (recordSyncSuccess, recordSyncFailure,
      // enableSupplierSource); a config update is the one event that legitimately clears it,
      // and a `{ name }` patch is not a config change.
      nextStatus = STATUS.ACTIVE;
      nextLastError = null;
    }
  }
  const next = {
    name: patch.name ?? row.name,
    syncMode: patch.syncMode ?? row.syncMode,
    syncIntervalSec: nextSyncIntervalSec,
    isActive: patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : row.isActive,
    authEnc: row.authEnc,
  };
  // Re-encrypt the MERGED config, so an omitted key keeps its stored value.
  if (clearAuth) {
    next.authEnc = null;
  } else if (hasAuthPatch) {
    next.authEnc = Object.keys(mergedAuth).length > 0 ? encrypt(JSON.stringify(mergedAuth)) : null;
  }
  db.run(
    `UPDATE supplierSources SET name=?, syncMode=?, syncIntervalSec=?, isActive=?, authEnc=?, status=?, lastSyncError=?, updatedAt=? WHERE id=?`,
    [next.name, next.syncMode, next.syncIntervalSec, next.isActive, next.authEnc, nextStatus, nextLastError, new Date().toISOString(), id]
  );
  return getSupplierSourceById(id);
}

/**
 * Delete a supplier source + cascade-delete its synced external products (D1).
 * External products are derived sync artifacts owned by the source (gated isActive=0
 * until 2.31) — removing the source removes its catalog to avoid dangling
 * supplierSourceId refs. Local products (source='local') are NEVER touched.
 */
export async function deleteSupplierSource(id) {
  const db = await getAdapter();
  let changes = 0;
  db.transaction(() => {
    db.run(
      `DELETE FROM products WHERE source = ? AND supplierSourceId = ?`,
      [EXTERNAL_SOURCE, id]
    );
    const res = db.run(`DELETE FROM supplierSources WHERE id = ?`, [id]);
    changes = res?.changes ?? 0;
  });
  return changes > 0;
}

/**
 * Record a successful sync — reset health to active, bump syncVersion, stamp lastSyncedAt (QĐ6).
 */
export async function recordSyncSuccess(id, { syncVersion } = {}) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM supplierSources WHERE id = ?`, [id]);
  if (!row) return null;
  // Unsupported sources never auto-heal to active via sync (they were rejected by validate).
  const nextStatus = row.status === STATUS.UNSUPPORTED ? STATUS.UNSUPPORTED : STATUS.ACTIVE;
  const nextVersion = syncVersion != null ? syncVersion : (row.syncVersion ?? 0) + 1;
  const now = new Date().toISOString();
  db.run(
    `UPDATE supplierSources SET status=?, lastSyncedAt=?, lastSyncError=NULL, syncVersion=?, updatedAt=? WHERE id=?`,
    [nextStatus, now, nextVersion, now, id]
  );
  return getSupplierSourceById(id);
}

/**
 * Record a sync failure — degrade health (QĐ6/AC5): active→degraded, degraded/unhealthy→unhealthy.
 * Stores lastSyncError so admin sees the most recent failure reason.
 */
export async function recordSyncFailure(id, error) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM supplierSources WHERE id = ?`, [id]);
  if (!row) return null;
  let nextStatus;
  if (row.status === STATUS.ACTIVE) nextStatus = STATUS.DEGRADED;
  else if (row.status === STATUS.UNSUPPORTED) nextStatus = STATUS.UNSUPPORTED; // stays unsupported
  else nextStatus = STATUS.UNHEALTHY; // degraded or unhealthy → unhealthy
  const reason = typeof error === "string" ? error : (error?.message || "sync failed");
  db.run(
    `UPDATE supplierSources SET status=?, lastSyncError=?, updatedAt=? WHERE id=?`,
    [nextStatus, reason.slice(0, 500), new Date().toISOString(), id]
  );
  return getSupplierSourceById(id);
}

/**
 * Explicitly mark a source unsupported (AC2) — e.g. scrape/private-bot integration.
 */
export async function markSourceUnsupported(id, reason) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM supplierSources WHERE id = ?`, [id]);
  if (!row) return null;
  db.run(
    `UPDATE supplierSources SET status=?, lastSyncError=?, updatedAt=? WHERE id=?`,
    [STATUS.UNSUPPORTED, String(reason || "Integration not supported in MVP").slice(0, 500), new Date().toISOString(), id]
  );
  return getSupplierSourceById(id);
}

/**
 * List sources due for polling (syncMode='polling', active/degraded, interval elapsed).
 * Excludes 'unsupported' AND 'unhealthy' (QĐ6/D3): unhealthy = cần admin can thiệp,
 * KHÔNG auto-retry mỗi interval (manual ?action=sync reset về active). Used by runDuePolls() (T5).
 */
export async function listPollableSources() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM supplierSources WHERE syncMode = 'polling' AND isActive = 1 AND status NOT IN ('unsupported', 'unhealthy')`
  );
  const now = Date.now();
  return rows.filter(r => {
    const interval = (r.syncIntervalSec ?? 3600) * 1000;
    if (!r.lastSyncedAt) return true; // never synced
    return now - new Date(r.lastSyncedAt).getTime() >= interval;
  }).map(maskSource);
}

/**
 * Story 2.34 (AC1) — list all sources WITH external-product counts (total + published)
 * in a single pass. Avoids N+1 per-source count queries on the admin dashboard.
 * Counts join products on supplierSourceId (external products only).
 * @returns {Promise<Array<object & { productCounts: { total: number, published: number } }>>}
 */
export async function listSupplierSourcesWithCounts() {
  const db = await getAdapter();
  const sources = db.all(`SELECT * FROM supplierSources ORDER BY createdAt DESC`);
  // One grouped query for all sources → map by supplierSourceId.
  const counts = db.all(
    `SELECT supplierSourceId,
            COUNT(*) AS total,
            SUM(CASE WHEN isPublished = 1 THEN 1 ELSE 0 END) AS published
     FROM products
     WHERE source = ? AND supplierSourceId IS NOT NULL
     GROUP BY supplierSourceId`,
    [EXTERNAL_SOURCE]
  );
  const countMap = new Map(
    counts.map((c) => [c.supplierSourceId, { total: c.total ?? 0, published: c.published ?? 0 }])
  );
  return sources.map((row) => ({
    ...maskSource(row),
    productCounts: countMap.get(row.id) ?? { total: 0, published: 0 },
  }));
}

/**
 * Story 2.34 (AC1) — admin force-disable a source: isActive=0 + status='unhealthy'.
 * Disabled sources are excluded from polling and their products are hidden (T4) +
 * fail-closed on checkout (T3). Idempotent. Returns the masked source or null if not found.
 */
export async function disableSupplierSource(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM supplierSources WHERE id = ?`, [id]);
  if (!row) return null;
  db.run(
    `UPDATE supplierSources SET isActive = 0, status = ?, updatedAt = ? WHERE id = ?`,
    [STATUS.UNHEALTHY, new Date().toISOString(), id]
  );
  return getSupplierSourceById(id);
}

/**
 * Story 2.34 (AC1) — admin re-enable a source: isActive=1 + status reset to 'active'.
 * Unsupported sources are NOT auto-healed (they failed validate — keep unsupported so
 * admin must fix config first). Idempotent. Returns the masked source or null if not found.
 */
export async function enableSupplierSource(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM supplierSources WHERE id = ?`, [id]);
  if (!row) return null;
  const nextStatus = row.status === STATUS.UNSUPPORTED ? STATUS.UNSUPPORTED : STATUS.ACTIVE;
  db.run(
    `UPDATE supplierSources SET isActive = 1, status = ?, lastSyncError = NULL, updatedAt = ? WHERE id = ?`,
    [nextStatus, new Date().toISOString(), id]
  );
  return getSupplierSourceById(id);
}

