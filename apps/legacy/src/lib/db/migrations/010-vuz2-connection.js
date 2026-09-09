import { randomUUID } from "node:crypto";

// Migration 010: duplicate vuz connection as vuz-2 for concurrent request capacity
//
// The auth system does not track "in-use" connections — it only checks model locks
// and exclusion sets. With a single connection (vuz), concurrent requests all pile
// onto the same upstream fetch, causing "fetch connect timeout" under load.
//
// vuz-2 is a clean copy of vuz (same API key, same upstream) but with zeroed-out
// usage tracking (no model locks, no errors, no consecutiveUseCount).
// This gives the system 2 available connections → 2x concurrent capacity.

function connectionExists(db, name) {
  return !!db.get(
    `SELECT 1 AS hit FROM providerConnections WHERE name = ?`,
    [name]
  );
}

const migration = {
  version: 10,
  name: "vuz2-connection",
  up(db) {
    if (connectionExists(db, "vuz-2")) return;

    const vuz = db.get(
      `SELECT * FROM providerConnections WHERE name = ? AND isActive = 1 ORDER BY priority LIMIT 1`,
      ["vuz"]
    );

    if (!vuz) {
      console.warn("[DB][migrate] #10 vuz2-connection: vuz not found, skipping");
      return;
    }

    let data;
    try {
      data = JSON.parse(vuz.data);
    } catch {
      console.warn("[DB][migrate] #10 vuz2-connection: invalid vuz data, skipping");
      return;
    }

    data.consecutiveUseCount = 0;
    delete data.lastUsedAt;
    data.lastError = null;
    data.lastErrorAt = null;
    data.errorCode = null;
    for (const key of Object.keys(data)) {
      if (key.startsWith("modelLock_")) data[key] = null;
    }

    const now = new Date().toISOString();
    const newId = randomUUID();

    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, ownerUserId, entitlementId)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [
        newId,
        vuz.provider,
        vuz.authType,
        "vuz-2",
        vuz.email || "",
        vuz.priority || 1,
        1,
        JSON.stringify(data),
        now,
        now,
      ]
    );

    console.log("[DB][migrate] #10 vuz2-connection: created vuz-2 from", vuz.name);
  },
};

export default migration;
