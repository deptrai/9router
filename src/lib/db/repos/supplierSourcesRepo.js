// Story 2.30 — supplierSourcesRepo: external supplier source CRUD + health lifecycle.
// Auth credentials encrypted at rest (STORE_ENC_KEY, reuse 2.27 secretBox).
// API NEVER returns authEnc/plaintext — list/get mask to { hasAuth: boolean } (QĐ8).
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { encrypt, decrypt } from "../../crypto/secretBox.js";
import { getAdapter as getSupplierAdapter } from "../../store/suppliers/index.js";

// Enum tập trung (E8) — single source of truth, import thay vì hardcode string.
export const ADAPTER_TYPES = ["supplier_api", "channel_feed", "polling_feed", "webhook"];
export const SYNC_MODES = ["webhook", "polling"];
export const SOURCE_STATUSES = ["active", "degraded", "unhealthy", "unsupported"];

// Min polling interval — chặn syncIntervalSec=0/âm hammer supplier ở full rate (edge-case guard).
export const MIN_SYNC_INTERVAL_SEC = 60;

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
  const syncIntervalSec = data.syncIntervalSec != null
    ? Math.max(MIN_SYNC_INTERVAL_SEC, Number(data.syncIntervalSec) || 0)
    : 3600;

  const adapter = getSupplierAdapter(data.adapterType);
  const auth = data.auth || {};
  const validation = adapter.validate(auth);
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
  // Re-validate auth via adapter when credentials change (AC1/QĐ4 — validate runs on every save,
  // not only at create; blocks swapping in invalid/scrape config post-creation).
  let nextStatus = row.status;
  let nextLastError = row.lastSyncError;
  if (patch.auth && typeof patch.auth === "object") {
    const adapter = getSupplierAdapter(row.adapterType);
    const validation = adapter.validate(patch.auth);
    if (!validation.ok && !validation.unsupported) {
      throw new Error(`updateSupplierSource: invalid config — ${validation.reason}`);
    }
    // Unsupported config → flag source (AC2) instead of silently accepting.
    if (validation.unsupported) {
      nextStatus = STATUS.UNSUPPORTED;
      nextLastError = validation.reason;
    }
  }
  const next = {
    name: patch.name ?? row.name,
    syncMode: patch.syncMode ?? row.syncMode,
    syncIntervalSec: patch.syncIntervalSec != null
      ? Math.max(MIN_SYNC_INTERVAL_SEC, Number(patch.syncIntervalSec) || 0)
      : row.syncIntervalSec,
    isActive: patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : row.isActive,
    authEnc: row.authEnc,
  };
  // Re-encrypt auth only if a new auth object is supplied.
  if (patch.auth && typeof patch.auth === "object") {
    next.authEnc = Object.keys(patch.auth).length > 0 ? encrypt(JSON.stringify(patch.auth)) : null;
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
      `DELETE FROM products WHERE source = 'external_telegram_store' AND supplierSourceId = ?`,
      [id]
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

