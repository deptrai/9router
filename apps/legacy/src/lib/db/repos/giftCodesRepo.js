import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { recordCreditTxn } from "./creditLedgerRepo.js";

function rowToGiftCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    creditsAmount: row.creditsAmount,
    maxRedemptions: row.maxRedemptions ?? null,
    redeemedCount: row.redeemedCount ?? 0,
    expiresAt: row.expiresAt || null,
    isActive: row.isActive === 1 || row.isActive === true,
    note: row.note || null,
    createdBy: row.createdBy || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToRedemption(row) {
  if (!row) return null;
  return {
    id: row.id,
    giftCodeId: row.giftCodeId,
    code: row.code,
    userId: row.userId,
    creditsAwarded: row.creditsAwarded,
    redeemedAt: row.redeemedAt,
  };
}

function normalizeCode(code) {
  if (!code || typeof code !== "string") return null;
  return code.trim().toUpperCase();
}

function isValidCodeFormat(code) {
  if (!code) return false;
  return /^[A-Z0-9_-]{4,64}$/.test(code);
}

export async function createGiftCode(data) {
  const db = await getAdapter();
  const id = uuidv4();
  const now = new Date().toISOString();

  let code = normalizeCode(data.code);
  if (!code) {
    // Generate a human-readable code
    const crypto = await import("crypto");
    const generateCode = () => {
      const bytes = crypto.randomBytes(8);
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let result = "GIFT-";
      for (let i = 0; i < 8; i++) {
        result += chars[bytes[i] % chars.length];
      }
      return result;
    };
    code = generateCode();

    // Retry on collision (extremely unlikely with 36^8 combinations)
    let attempts = 0;
    while (attempts < 10) {
      const existing = db.get(`SELECT id FROM giftCodes WHERE code = ?`, [code]);
      if (!existing) break;
      code = generateCode();
      attempts++;
    }
    if (attempts >= 10) {
      throw new Error("Failed to generate unique gift code after 10 attempts");
    }
  }

  if (!isValidCodeFormat(code)) {
    throw new Error("Invalid code format. Must be 4-64 uppercase letters, numbers, underscores, or hyphens.");
  }

  const giftCode = {
    id,
    code,
    creditsAmount: data.creditsAmount,
    maxRedemptions: data.maxRedemptions ?? null,
    redeemedCount: 0,
    expiresAt: data.expiresAt || null,
    isActive: data.isActive !== false,
    note: data.note || null,
    createdBy: data.createdBy || null,
    createdAt: now,
    updatedAt: now,
  };

  db.run(
    `INSERT INTO giftCodes(id, code, creditsAmount, maxRedemptions, redeemedCount, expiresAt, isActive, note, createdBy, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [giftCode.id, giftCode.code, giftCode.creditsAmount, giftCode.maxRedemptions, giftCode.redeemedCount, giftCode.expiresAt, giftCode.isActive ? 1 : 0, giftCode.note, giftCode.createdBy, giftCode.createdAt, giftCode.updatedAt]
  );

  return giftCode;
}

export async function getGiftCodeByCode(code) {
  const db = await getAdapter();
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const row = db.get(`SELECT * FROM giftCodes WHERE code = ?`, [normalized]);
  return rowToGiftCode(row);
}

export async function getGiftCodeById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM giftCodes WHERE id = ?`, [id]);
  return rowToGiftCode(row);
}

export async function listGiftCodes({ limit = 50, offset = 0, includeInactive = true } = {}) {
  const db = await getAdapter();

  const nLimit = Math.trunc(Number(limit));
  const safeLimit = Number.isFinite(nLimit) && nLimit > 0 ? Math.min(nLimit, 500) : 50;
  const nOffset = Math.trunc(Number(offset));
  const safeOffset = Number.isFinite(nOffset) && nOffset > 0 ? nOffset : 0;

  let sql = `SELECT * FROM giftCodes`;
  if (!includeInactive) {
    sql += ` WHERE isActive = 1`;
  }
  sql += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;

  const rows = db.all(sql, [safeLimit, safeOffset]);
  return rows.map(rowToGiftCode);
}

export async function updateGiftCode(id, data) {
  const db = await getAdapter();
  const clean = Object.fromEntries(
    Object.entries(data || {}).filter(([, v]) => v !== undefined)
  );
  if (Object.keys(clean).length === 0) return null;

  const now = new Date().toISOString();
  let result = null;

  db.transaction(() => {
    const row = db.get(`SELECT * FROM giftCodes WHERE id = ?`, [id]);
    if (!row) return;

    const merged = { ...rowToGiftCode(row), ...clean, updatedAt: now };
    db.run(
      `UPDATE giftCodes SET code=?, creditsAmount=?, maxRedemptions=?, expiresAt=?, isActive=?, note=?, createdBy=?, updatedAt=? WHERE id=?`,
      [merged.code, merged.creditsAmount, merged.maxRedemptions, merged.expiresAt, merged.isActive ? 1 : 0, merged.note, merged.createdBy, merged.updatedAt, id]
    );
    result = merged;
  });

  return result;
}

export async function disableGiftCode(id) {
  return updateGiftCode(id, { isActive: false });
}

export async function redeemGiftCode({ code, userId, db = null }) {
  const adapter = db || await getAdapter();
  const normalized = normalizeCode(code);

  if (!normalized) {
    const error = new Error("Invalid gift code format");
    error.code = "INVALID_CODE";
    throw error;
  }

  let result = null;

  adapter.transaction(() => {
    // Fresh read inside transaction
    const row = adapter.get(`SELECT * FROM giftCodes WHERE code = ?`, [normalized]);
    if (!row) {
      const error = new Error("Gift code not found");
      error.code = "NOT_FOUND";
      throw error;
    }

    const giftCode = rowToGiftCode(row);

    if (!giftCode.isActive) {
      const error = new Error("Gift code inactive");
      error.code = "INACTIVE";
      throw error;
    }

    if (giftCode.expiresAt && new Date(giftCode.expiresAt) <= new Date()) {
      const error = new Error("Gift code expired");
      error.code = "EXPIRED";
      throw error;
    }

    if (giftCode.maxRedemptions !== null && giftCode.redeemedCount >= giftCode.maxRedemptions) {
      const error = new Error("Gift code fully redeemed");
      error.code = "EXHAUSTED";
      throw error;
    }

    // Check for duplicate redemption (UNIQUE constraint also guards at DB level)
    const existingRedemption = adapter.get(
      `SELECT id FROM giftCodeRedemptions WHERE giftCodeId = ? AND userId = ?`,
      [giftCode.id, userId]
    );
    if (existingRedemption) {
      const error = new Error("Gift code already redeemed");
      error.code = "ALREADY_REDEEMED";
      throw error;
    }

    // Insert redemption
    const redemptionId = uuidv4();
    const redeemedAt = new Date().toISOString();
    adapter.run(
      `INSERT INTO giftCodeRedemptions(id, giftCodeId, code, userId, creditsAwarded, redeemedAt)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [redemptionId, giftCode.id, giftCode.code, userId, giftCode.creditsAmount, redeemedAt]
    );

    // Increment redeemedCount
    adapter.run(
      `UPDATE giftCodes SET redeemedCount = redeemedCount + 1, updatedAt = ? WHERE id = ?`,
      [redeemedAt, giftCode.id]
    );

    // Award credits as bonus bucket with 14-day expiry (gift_code type per ledger contract)
    const bonusExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    recordCreditTxn({
      userId,
      type: "gift_code",
      bucket: "bonus",
      amount: giftCode.creditsAmount,
      refId: giftCode.id,
      idempotencyKey: `gift:${giftCode.id}:${userId}`,
      expiresAt: bonusExpiry,
    }, adapter);

    // Read new balance
    const userRow = adapter.get(`SELECT creditsBalance FROM users WHERE id = ?`, [userId]);
    const newBalance = userRow?.creditsBalance ?? 0;

    result = {
      success: true,
      creditsAwarded: giftCode.creditsAmount,
      newBalance,
    };
  });

  return result;
}

export async function listGiftCodeRedemptions({ userId, giftCodeId, limit = 50, offset = 0 } = {}) {
  const db = await getAdapter();

  const nLimit = Math.trunc(Number(limit));
  const safeLimit = Number.isFinite(nLimit) && nLimit > 0 ? Math.min(nLimit, 500) : 50;
  const nOffset = Math.trunc(Number(offset));
  const safeOffset = Number.isFinite(nOffset) && nOffset > 0 ? nOffset : 0;

  let sql = `SELECT * FROM giftCodeRedemptions`;
  const conds = [];
  const params = [];

  if (userId) {
    conds.push(`userId = ?`);
    params.push(userId);
  }
  if (giftCodeId) {
    conds.push(`giftCodeId = ?`);
    params.push(giftCodeId);
  }

  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += ` ORDER BY redeemedAt DESC LIMIT ? OFFSET ?`;
  params.push(safeLimit, safeOffset);

  const rows = db.all(sql, params);
  return rows.map(rowToRedemption);
}
