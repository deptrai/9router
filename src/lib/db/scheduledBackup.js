/**
 * scheduledBackup.js — Daily SQLite database backup
 *
 * Uses SQLite VACUUM INTO for WAL-safe consistent snapshots.
 * Retains last N backups (BACKUP_KEEP_COUNT env, default 7).
 * Called from setInterval in initializeApp (24h cadence).
 */

import fs from "node:fs";
import { DATA_FILE, BACKUPS_DIR, ensureDirs } from "./paths.js";
import { getAdapter } from "./driver.js";

const DEFAULT_KEEP_COUNT = 7;
const BACKUP_PREFIX = "data.sqlite.daily-";

/**
 * How many backups to retain. Sanitized hard: `Number("abc")` is NaN and
 * `entries.slice(NaN)` behaves like `slice(0)`, which deleted EVERY backup including the
 * one just created — and a negative value made `slice(-3)` delete the three newest. A typo
 * in one env var used to silently turn the backup job into a delete-everything job.
 */
function keepCount() {
  const raw = process.env.BACKUP_KEEP_COUNT;
  if (raw === undefined || raw === "") return DEFAULT_KEEP_COUNT;
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn(`[scheduledBackup] Invalid BACKUP_KEEP_COUNT="${raw}", falling back to ${DEFAULT_KEEP_COUNT}.`);
    return DEFAULT_KEEP_COUNT;
  }
  return parsed;
}

/** Timestamped name with a uniquifier — the second-resolution stamp alone collides. */
function backupName(now) {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${BACKUP_PREFIX}${stamp}-${process.pid}`;
}

function prune(keep) {
  const entries = [];
  for (const name of fs.readdirSync(BACKUPS_DIR)) {
    if (!name.startsWith(BACKUP_PREFIX)) continue;
    const full = `${BACKUPS_DIR}/${name}`;
    try {
      entries.push({ name, full, mtime: fs.statSync(full).mtimeMs });
    } catch {
      // Removed by a concurrent prune between readdir and stat. Previously an unguarded
      // statSync here rejected the whole runScheduledBackup() call even though the backup
      // had already been written successfully.
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);

  let pruned = 0;
  for (const old of entries.slice(keep)) {
    try {
      fs.unlinkSync(old.full);
      pruned += 1;
    } catch (error) {
      // Log instead of swallowing: a persistent EPERM/EBUSY silently fills the disk.
      console.warn(`[scheduledBackup] Could not prune ${old.name}: ${error.message}`);
    }
  }
  if (pruned > 0) {
    console.log(`[scheduledBackup] Pruned ${pruned} old backup(s), keeping ${keep}.`);
  }
}

export async function runScheduledBackup() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log("[scheduledBackup] No database file found, skipping.");
    return null;
  }

  const db = await getAdapter();
  // VACUUM INTO writes through the SQLite driver, so under the sql.js (WASM) fallback the
  // destination path resolves inside the in-memory MEMFS and NOTHING lands on the host
  // disk — while we happily logged "Backup created". better-sqlite3 is an
  // optionalDependency, so sql.js is a real production path whenever its native build is
  // unavailable. Refuse loudly rather than pretend to have a backup.
  if (db.driver === "sql.js") {
    console.warn("[scheduledBackup] Driver is sql.js (WASM in-memory FS) — VACUUM INTO cannot write to the host filesystem. Skipping backup. Install better-sqlite3 or run on Node >= 22.5 (node:sqlite) to enable backups.");
    return null;
  }

  ensureDirs();

  const name = backupName(new Date());
  const dest = `${BACKUPS_DIR}/${name}`;

  // F3 fix: Use VACUUM INTO for WAL-safe consistent snapshot
  // (copyFileSync misses uncommitted WAL data)
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  console.log(`[scheduledBackup] Backup created: ${name}`);

  prune(keepCount());

  return dest;
}
