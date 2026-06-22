import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";
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
    googleSub: row.googleSub ?? null,
    telegramId: row.telegramId ?? null,
    refCode: row.refCode ?? null,
    referredBy: row.referredBy ?? null,
    authProviders: [
      (row.passwordHash && row.passwordHash !== "!") ? "password" : null,
      row.googleSub ? "google" : null,
      row.telegramId ? "telegram" : null,
    ].filter(Boolean),
    hasPassword: !!(row.passwordHash && row.passwordHash !== "!"),
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
  const effectiveHash = passwordHash || "!"; // "!" = social-only sentinel (not a valid bcrypt hash)
  const refCode = crypto.randomBytes(4).toString("hex");
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, isActive, isEmailVerified, creditsBalance, refCode, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, 1, 0, 0, ?, ?, ?)`,
    [id, email, effectiveHash, displayName || null, refCode, now, now]
  );
  return { id, email, displayName: displayName || null, isActive: true, isEmailVerified: false, creditsBalance: 0, refCode, hasPassword: !!passwordHash, createdAt: now, updatedAt: now };
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
      `UPDATE users SET email = ?, passwordHash = ?, displayName = ?, isActive = ?, isEmailVerified = ?, creditsBalance = ?, planId = ?, planExpiresAt = ?, allowCreditOverflow = ?, googleSub = ?, telegramId = ?, authProviders = ?, refCode = ?, referredBy = ?, updatedAt = ? WHERE id = ?`,
      [merged.email, merged.passwordHash, merged.displayName, merged.isActive ? 1 : 0, merged.isEmailVerified ? 1 : 0, merged.creditsBalance, merged.planId ?? null, merged.planExpiresAt ?? null, merged.allowCreditOverflow ? 1 : 0, merged.googleSub ?? null, merged.telegramId ?? null, merged.authProviders ?? null, merged.refCode ?? null, merged.referredBy ?? null, merged.updatedAt, id]
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

export async function listUsers({ offset = 0, limit = 50, search, planId, balanceFilter, sort = "createdAt", order = "asc" } = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (search) {
    conds.push("(users.email LIKE ? OR users.displayName LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (planId === "none") {
    conds.push("users.planId IS NULL");
  } else if (planId) {
    conds.push("users.planId = ?");
    params.push(planId);
  }
  if (balanceFilter === "zero") conds.push("users.creditsBalance <= 0");
  else if (balanceFilter === "low") conds.push("users.creditsBalance > 0 AND users.creditsBalance < 1.0");
  else if (balanceFilter === "normal") conds.push("users.creditsBalance >= 1.0");

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const sortCol = sort === "balance" ? "users.creditsBalance" : "users.createdAt";
  const sortOrder = order === "desc" ? "DESC" : "ASC";

  const total = db.get(
    `SELECT COUNT(*) as n FROM users LEFT JOIN plans ON plans.id = users.planId ${where}`,
    params
  )?.n ?? 0;

  const rows = db.all(
    `SELECT users.*, plans.name AS planName, plans.displayName AS planDisplayName, plans.isActive AS planIsActive
     FROM users
     LEFT JOIN plans ON plans.id = users.planId
     ${where}
     ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { users: rows.map((row) => rowToUser(row, false)), total };
}

export async function deactivateUser(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`UPDATE users SET isActive = 0, updatedAt = ? WHERE id = ?`, [now, id]);
}

export async function getUserByGoogleSub(googleSub) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE googleSub = ?`, [googleSub]);
  return rowToUser(row, true);
}

export async function getUserByTelegramId(telegramId) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE telegramId = ?`, [telegramId]);
  return rowToUser(row, true);
}

export async function getUserByRefCode(refCode) {
  if (!refCode) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE refCode = ?`, [refCode]);
  return rowToUser(row, false);
}

export async function getReferrals(userId, { limit = 10, offset = 0 } = {}) {
  const db = await getAdapter();
  return db.all(
    `SELECT id, displayName, email, createdAt FROM users WHERE referredBy = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
}

export async function getReferralCount(userId) {
  const db = await getAdapter();
  const row = db.get(`SELECT COUNT(*) as count FROM users WHERE referredBy = ?`, [userId]);
  return row?.count ?? 0;
}
