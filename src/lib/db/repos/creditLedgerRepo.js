/**
 * creditLedgerRepo — Immutable append-only credit ledger (Story 2.13, E.3b)
 *
 * Billing Best Practices enforced here:
 *   BP-1: ONLY INSERT — never UPDATE/DELETE a ledger row. Corrections via reverseTxn().
 *   BP-2: rebuildBalanceFromLedger() is the authoritative reconciliation tool.
 *   BP-3: Every row has type + refId.
 *   BP-4: idempotencyKey UNIQUE prevents double-credit.
 *   BP-5: recordCreditTxn writes ledger + updates cache in ONE db.transaction().
 *   BP-6: amount/balanceAfter stored as REAL — known-limitation (float rounding at scale).
 *         Migrate to micro-USD integer if financial scale demands precision.
 *   BP-7: bucket/expiresAt/multiplier schema-ready; enforcement of priority order → FR-13/14/15.
 *
 * Known-limitation (BP-6): Money uses REAL/float. Acceptable at current LLM-cost scale.
 */

import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// ─── Core write ──────────────────────────────────────────────────────────────

/**
 * Record one credit transaction and atomically update users.creditsBalance cache.
 *
 * BP-4: If idempotencyKey already exists → return existing row (no-op).
 * BP-5: ledger INSERT + balance UPDATE in same db.transaction().
 *
 * @param {{ userId, type, bucket?, amount, multiplier?, expiresAt?, refId?, idempotencyKey?, note? }} txn
 * @param {object|null} db - Optional adapter for nesting into caller's transaction (BP-5 atomicity).
 *   Pass the adapter when calling from inside an existing transaction (settle.js, saveRequestUsage).
 *   Pass null to open a new transaction.
 * @returns {{ id, userId, type, bucket, amount, multiplier, expiresAt, refId, idempotencyKey, balanceAfter, note, createdAt }}
 */
function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`recordCreditTxn: ${field} is required`);
  }
}

function validateTxn({ userId, type, amount, refId }) {
  requireNonEmptyString(userId, "userId");
  requireNonEmptyString(type, "type");
  if (!Number.isFinite(amount)) {
    throw new Error("recordCreditTxn: amount must be a finite number");
  }
  if (type !== "migration") {
    requireNonEmptyString(refId, "refId");
  }
}

function recordCreditTxnWithAdapter(
  { userId, type, bucket = "standard", amount, multiplier = 1, expiresAt = null, refId = null, idempotencyKey = null, note = null },
  adapter,
  wrapTransaction
) {
  validateTxn({ userId, type, amount, refId });
  let result = null;

  const doWork = () => {
    // BP-4: idempotency check
    if (idempotencyKey) {
      const existing = adapter.get(`SELECT * FROM creditTransactions WHERE idempotencyKey = ?`, [idempotencyKey]);
      if (existing) {
        result = existing;
        return;
      }
    }

    // BP-6: snapshot balanceAfter = current cache + amount
    const userRow = adapter.get(`SELECT creditsBalance FROM users WHERE id = ?`, [userId]);
    const currentBalance = userRow?.creditsBalance ?? 0;
    const balanceAfter = currentBalance + amount;

    const id = uuidv4();
    const createdAt = new Date().toISOString();

    // BP-1: INSERT only, never UPDATE/DELETE
    adapter.run(
      `INSERT INTO creditTransactions(id, userId, type, bucket, amount, multiplier, expiresAt, refId, idempotencyKey, balanceAfter, note, createdAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, type, bucket, amount, multiplier, expiresAt, refId, idempotencyKey, balanceAfter, note, createdAt]
    );

    // BP-5: cache update in same transaction
    adapter.run(
      `UPDATE users SET creditsBalance = creditsBalance + ?, updatedAt = ? WHERE id = ?`,
      [amount, createdAt, userId]
    );

    result = { id, userId, type, bucket, amount, multiplier, expiresAt, refId, idempotencyKey, balanceAfter, note, createdAt };
  };

  if (wrapTransaction) {
    adapter.transaction(doWork);
  } else {
    // Caller already owns a transaction — run inline without nesting.
    // This branch is intentionally synchronous so DB errors abort the outer transaction.
    doWork();
  }

  return result;
}

export function recordCreditTxn(txn, db = null) {
  if (db) {
    return recordCreditTxnWithAdapter(txn, db, false);
  }
  return (async () => {
    const adapter = await getAdapter();
    return recordCreditTxnWithAdapter(txn, adapter, true);
  })();
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Get ledger rows for a user, newest first.
 * @param {string} userId
 * @param {{ limit?, offset?, type?, bucket? }} opts
 */
export async function getLedgerByUser(userId, { limit = 50, offset = 0, type = null, bucket = null } = {}) {
  const adapter = await getAdapter();
  let sql = `SELECT * FROM creditTransactions WHERE userId = ?`;
  const params = [userId];
  if (type) { sql += ` AND type = ?`; params.push(type); }
  if (bucket) { sql += ` AND bucket = ?`; params.push(bucket); }
  sql += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return adapter.all(sql, params);
}

/**
 * BP-2: Rebuild balance from ledger (authoritative reconciliation).
 * Sums all rows where expiresAt IS NULL OR expiresAt > now per bucket.
 * @param {string} userId
 * @returns {number} authoritative balance
 */
export async function rebuildBalanceFromLedger(userId) {
  const adapter = await getAdapter();
  const now = new Date().toISOString();
  const row = adapter.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM creditTransactions
     WHERE userId = ? AND (expiresAt IS NULL OR expiresAt > ?)`,
    [userId, now]
  );
  return row?.total ?? 0;
}

// ─── Correction (BP-1) ───────────────────────────────────────────────────────

/**
 * BP-1: Reverse a transaction by writing a new reversal row (never modify original).
 * @param {string} originalId - id of the row to reverse
 * @param {string} note - reason for reversal
 * @param {object|null} db - optional adapter for nesting
 */
function reverseTxnWithAdapter(originalId, note, adapter, wrapTransaction) {
  let result = null;

  const doWork = () => {
    const orig = adapter.get(`SELECT * FROM creditTransactions WHERE id = ?`, [originalId]);
    if (!orig) throw new Error(`reverseTxn: original transaction ${originalId} not found`);
    if (orig.type === "reversal") throw new Error(`reverseTxn: cannot reverse a reversal row`);

    // Check not already reversed (idempotency)
    const alreadyReversed = adapter.get(
      `SELECT id FROM creditTransactions WHERE type = 'reversal' AND refId = ?`, [originalId]
    );
    if (alreadyReversed) {
      result = alreadyReversed;
      return;
    }

    const reversalIdempotency = `reversal:${originalId}`;
    const existing = adapter.get(`SELECT * FROM creditTransactions WHERE idempotencyKey = ?`, [reversalIdempotency]);
    if (existing) { result = existing; return; }

    const userRow = adapter.get(`SELECT creditsBalance FROM users WHERE id = ?`, [orig.userId]);
    const currentBalance = userRow?.creditsBalance ?? 0;
    const reversalAmount = -orig.amount;
    const balanceAfter = currentBalance + reversalAmount;
    const id = uuidv4();
    const createdAt = new Date().toISOString();

    adapter.run(
      `INSERT INTO creditTransactions(id, userId, type, bucket, amount, multiplier, expiresAt, refId, idempotencyKey, balanceAfter, note, createdAt)
       VALUES(?, ?, 'reversal', ?, ?, 1, NULL, ?, ?, ?, ?, ?)`,
      [id, orig.userId, orig.bucket, reversalAmount, originalId, reversalIdempotency, balanceAfter, note || `Reversal of ${originalId}`, createdAt]
    );

    adapter.run(
      `UPDATE users SET creditsBalance = creditsBalance + ?, updatedAt = ? WHERE id = ?`,
      [reversalAmount, createdAt, orig.userId]
    );

    result = { id, userId: orig.userId, type: "reversal", bucket: orig.bucket, amount: reversalAmount, refId: originalId, idempotencyKey: reversalIdempotency, balanceAfter, note, createdAt };
  };

  if (wrapTransaction) {
    adapter.transaction(doWork);
  } else {
    doWork();
  }

  return result;
}

export function reverseTxn(originalId, note, db = null) {
  if (db) {
    return reverseTxnWithAdapter(originalId, note, db, false);
  }
  return (async () => {
    const adapter = await getAdapter();
    return reverseTxnWithAdapter(originalId, note, adapter, true);
  })();
}
