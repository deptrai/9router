import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { recordCreditTxn } from "./creditLedgerRepo.js";

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
    planId: row.planId ?? null,
    planExpiresAt: row.planExpiresAt ?? null,
    allowCreditOverflow: row.allowCreditOverflow === 1 || row.allowCreditOverflow === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.planName !== undefined || row.planDisplayName !== undefined || row.planIsActive !== undefined) {
    user.plan = row.planId
      ? {
          id: row.planId,
          name: row.planName ?? null,
          displayName: row.planDisplayName ?? null,
          isActive: row.planIsActive === 1 || row.planIsActive === true,
        }
      : null;
  }
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
      `UPDATE users SET email = ?, passwordHash = ?, displayName = ?, isActive = ?, isEmailVerified = ?, creditsBalance = ?, planId = ?, planExpiresAt = ?, allowCreditOverflow = ?, updatedAt = ? WHERE id = ?`,
      [merged.email, merged.passwordHash, merged.displayName, merged.isActive ? 1 : 0, merged.isEmailVerified ? 1 : 0, merged.creditsBalance, merged.planId ?? null, merged.planExpiresAt ?? null, merged.allowCreditOverflow ? 1 : 0, merged.updatedAt, id]
    );
    result = rowToUser({ ...merged, isActive: merged.isActive }, false);
  });
  return result;
}

export async function addCredits(id, amount, db = null, { type = "admin_topup", refId = `legacy:addCredits:${id}`, idempotencyKey = null, note = null } = {}) {
  // Thin wrapper — delegates to ledger for audit trail (Story 2.13, BP-5).
  // Callers that already own a db.transaction() pass their adapter as `db`.
  await recordCreditTxn({ userId: id, type, bucket: "standard", amount, refId, idempotencyKey, note }, db);
}

export async function listUsers({ offset = 0, limit = 50 } = {}) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT users.*, plans.name AS planName, plans.displayName AS planDisplayName, plans.isActive AS planIsActive
     FROM users
     LEFT JOIN plans ON plans.id = users.planId
     ORDER BY users.createdAt ASC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return rows.map((row) => rowToUser(row, false));
}

export async function deactivateUser(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`UPDATE users SET isActive = 0, updatedAt = ? WHERE id = ?`, [now, id]);
}
