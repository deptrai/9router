import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    userId: row.userId ?? null,
    description: row.description ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    creditLimit: row.creditLimit ?? null,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, userId = null, description = null, creditLimit = null) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();

  // 10-key limit for users (count active keys only)
  if (userId) {
    const { c } = db.get(`SELECT COUNT(*) as c FROM apiKeys WHERE userId = ? AND isActive = 1`, [userId]);
    if (c >= 10) {
      const err = new Error("Key limit reached: max 10 keys per user");
      err.code = "KEY_LIMIT";
      throw err;
    }
  }

  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    userId,
    description,
    creditLimit: creditLimit ?? null,
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, userId, description, creditLimit) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, userId, description, apiKey.creditLimit]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, userId = ?, description = ?, lastUsedAt = ?, creditLimit = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.userId ?? null, merged.description ?? null, merged.lastUsedAt ?? null, merged.creditLimit ?? null, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function getApiKeyByKey(keyString) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [keyString]);
  return rowToKey(row);
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

export async function getApiKeysByUser(userId) {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys WHERE userId = ? ORDER BY createdAt ASC`, [userId]);
  return rows.map(rowToKey);
}

export async function updateLastUsed(keyString) {
  const db = await getAdapter();
  db.run(`UPDATE apiKeys SET lastUsedAt = ? WHERE key = ?`, [new Date().toISOString(), keyString]);
}
