import Database from "better-sqlite3";
import { PRAGMA_SQL } from "../schema.js";
import { registerCleanup, unregisterCleanup } from "../cleanupRegistry.js";

// Periodic checkpoint to keep WAL file small (avoid huge -wal/-shm growth)
const CHECKPOINT_INTERVAL_MS = 60 * 1000;

let _instanceSeq = 0;

export function createBetterSqliteAdapter(filePath) {
  const db = new Database(filePath);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  const stmtCache = new Map();

  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  // Truncate WAL periodically so file stays small for backup/copy
  const checkpointTimer = setInterval(() => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }

  // Ensure WAL is flushed and -wal/-shm files removed on shutdown.
  // Registered under a unique per-instance key so close() can unregister
  // cleanly (prevents listener accumulation when adapters are created
  // repeatedly, e.g. in tests). See cleanupRegistry.js for why this matters.
  const cleanupKey = `better-sqlite:${++_instanceSeq}`;
  registerCleanup(cleanupKey, () => gracefulClose());

  return {
    driver: "better-sqlite3",
    run(sql, params = []) { return prepare(sql).run(params); },
    get(sql, params = []) { return prepare(sql).get(params); },
    all(sql, params = []) { return prepare(sql).all(params); },
    exec(sql) { return db.exec(sql); },
    transaction(fn) { return db.transaction(fn)(); },
    checkpoint() { try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      clearInterval(checkpointTimer);
      unregisterCleanup(cleanupKey);
      gracefulClose();
    },
    raw: db,
  };
}
