import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

/**
 * Map DB row → user object.
 * DOES NOT expose passwordHash by default.
 */
function rowToUser(row, includePasswordHash = false) {
  if (!row) return null;
  const user = {
    id: row.id,
    email: row.email,
    displayName: row.displayName || null,
    isActive: row.isActive === 1 || row.isActive === true,
    isEmailVerified: row.isEmailVerified === 1 || row.isEmailVerified === true,
    creditsBalance: row.creditsBalance ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (includePasswordHash) {
    user.passwordHash = row.passwordHash;
  }
  return user;
}

export async function createUser(email, passwordHash, displayName) {
  const db = await getAdapter();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, isActive, isEmailVerified, creditsBalance, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, 1, 0, 0, ?, ?)`,
    [id, email, passwordHash, displayName || null, now, now]
  );
  return { id, email, displayName: displayName || null, isActive: true, isEmailVerified: false, creditsBalance: 0, createdAt: now, updatedAt: now };
}

export async function getUserByEmail(email) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE email = ?`, [email]);
  return rowToUser(row, true); // include passwordHash for login compare
}

export async function getUserById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE id = ?`, [id]);
  return rowToUser(row, false);
}

export async function updateUser(id, data) {
  const db = await getAdapter();
  // Filter undefined values to avoid overwriting fields with NULL (lesson from story 2.1)
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined)
  );
  if (Object.keys(clean).length === 0) return null;

  const now = new Date().toISOString();
  let result = null;

  db.transaction(() => {
    const row = db.get(`SELECT * FROM users WHERE id = ?`, [id]);
    if (!row) return;

    const merged = { ...row, ...clean, updatedAt: now };
    db.run(
      `UPDATE users SET email = ?, passwordHash = ?, displayName = ?, isActive = ?, isEmailVerified = ?, creditsBalance = ?, updatedAt = ? WHERE id = ?`,
      [merged.email, merged.passwordHash, merged.displayName, merged.isActive ? 1 : 0, merged.isEmailVerified ? 1 : 0, merged.creditsBalance, merged.updatedAt, id]
    );
    result = rowToUser({ ...merged, isActive: merged.isActive }, false);
  });
  return result;
}

export async function addCredits(id, amount, db = null) {
  const adapter = db || await getAdapter();
  const now = new Date().toISOString();
  adapter.run(
    `UPDATE users SET creditsBalance = creditsBalance + ?, updatedAt = ? WHERE id = ?`,
    [amount, now, id]
  );
}

export async function listUsers({ offset = 0, limit = 50 } = {}) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM users ORDER BY createdAt ASC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return rows.map((row) => rowToUser(row, false));
}

export async function deactivateUser(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`UPDATE users SET isActive = 0, updatedAt = ? WHERE id = ?`, [now, id]);
}
