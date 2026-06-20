/**
 * scheduledBackup.js — Daily SQLite database backup
 *
 * Copies the live database to BACKUPS_DIR with timestamped filename.
 * Retains last N backups (BACKUP_KEEP_COUNT env, default 7).
 * Called from setInterval in initializeApp (24h cadence).
 */

import fs from "node:fs";
import { DATA_FILE, BACKUPS_DIR, ensureDirs } from "./paths.js";

const KEEP_COUNT = () => Number(process.env.BACKUP_KEEP_COUNT || 7);

export async function runScheduledBackup() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log("[scheduledBackup] No database file found, skipping.");
    return null;
  }

  ensureDirs();

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupName = `data.sqlite.daily-${stamp}`;
  const dest = `${BACKUPS_DIR}/${backupName}`;

  fs.copyFileSync(DATA_FILE, dest);
  console.log(`[scheduledBackup] Backup created: ${backupName}`);

  // Prune old daily backups
  const entries = fs.readdirSync(BACKUPS_DIR)
    .filter((f) => f.startsWith("data.sqlite.daily-"))
    .map((f) => ({ name: f, full: `${BACKUPS_DIR}/${f}`, mtime: fs.statSync(`${BACKUPS_DIR}/${f}`).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const keep = KEEP_COUNT();
  for (const old of entries.slice(keep)) {
    try { fs.unlinkSync(old.full); } catch {}
  }

  if (entries.length > keep) {
    console.log(`[scheduledBackup] Pruned ${entries.length - keep} old backup(s), keeping ${keep}.`);
  }

  return dest;
}
