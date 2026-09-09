/**
 * credentialsRepo — individual credential inventory for Telegram Store (Story 2.27)
 *
 * productCredentials holds per-unit credential items (username/password pairs, API keys, etc.)
 * tied to a product. When a buyer purchases a kind=credential product with deliveryMode=instant,
 * storeCheckout picks available credentials (FIFO) and marks them delivered — atomically inside
 * the same db.transaction() that debits credits and creates the order.
 *
 * Status flow: available → delivered (via storeCheckout txn)
 *                        → revoked   (via admin action)
 */

import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { encrypt, decrypt } from "../../crypto/secretBox.js";

export const CREDENTIAL_STATUSES = ["available", "reserved", "delivered", "revoked"];

// Public mapper — never exposes payload or ciphertext (AC5, NFR8).
function rowToCredential(row) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.productId,
    hasPayload: !!row.payload,
    status: row.status,
    orderId: row.orderId ?? null,
    orderItemId: row.orderItemId ?? null,
    reservedAt: row.reservedAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Add a credential item to a product's inventory.
 * payload can be a plain object (JSON-serialised) or a string.
 * @param {string} productId
 * @param {object|string} payload  — the actual credential (e.g. { username, password })
 * @param {{ note?: string, id?: string }} [opts]
 */
export async function addCredential(productId, payload, { note = null, id = null } = {}) {
  if (!productId) throw new Error("addCredential: productId bắt buộc");
  if (payload === undefined || payload === null) throw new Error("addCredential: payload bắt buộc");
  const db = await getAdapter();
  const credId = id || uuidv4();
  const now = new Date().toISOString();
  const plaintext = typeof payload === "string" ? payload : JSON.stringify(payload);
  const payloadEnc = encrypt(plaintext); // fail-fast if STORE_ENC_KEY missing
  db.run(
    `INSERT INTO productCredentials(id, productId, payload, status, note, createdAt, updatedAt)
     VALUES(?, ?, ?, 'available', ?, ?, ?)`,
    [credId, productId, payloadEnc, note ?? null, now, now]
  );
  return rowToCredential(db.get(`SELECT * FROM productCredentials WHERE id = ?`, [credId]));
}

/**
 * List credentials for a product, optionally filtered by status.
 */
export async function listCredentials(productId, { status = null, limit = 50, offset = 0 } = {}) {
  const db = await getAdapter();
  const rows = status
    ? db.all(
        `SELECT * FROM productCredentials WHERE productId = ? AND status = ? ORDER BY createdAt ASC LIMIT ? OFFSET ?`,
        [productId, status, limit, offset]
      )
    : db.all(
        `SELECT * FROM productCredentials WHERE productId = ? ORDER BY createdAt ASC LIMIT ? OFFSET ?`,
        [productId, limit, offset]
      );
  return rows.map(rowToCredential);
}

export async function getCredentialById(id) {
  const db = await getAdapter();
  return rowToCredential(db.get(`SELECT * FROM productCredentials WHERE id = ?`, [id]));
}

/**
 * Count available credentials for a product. Useful for restocking dashboards.
 */
export async function countAvailableCredentials(productId) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT COUNT(*) AS cnt FROM productCredentials WHERE productId = ? AND status = 'available'`,
    [productId]
  );
  return row?.cnt ?? 0;
}

/**
 * D3 gate (QĐ1): does this product have ANY credential row ever created?
 * SYNC — safe to call inside the checkout txn.
 * If true, inventory is the source of truth for instant stock (skip products.stock).
 * If false, fall back to the products.stock path from Story 2.26.
 * Note: counts rows in ANY status (available|reserved|delivered|revoked) — a product
 * that sold out still "has inventory" and must route through NO_INVENTORY, not stock.
 */
export function productHasInventorySync(adapter, productId) {
  const row = adapter.get(
    `SELECT 1 AS hit FROM productCredentials WHERE productId = ? LIMIT 1`,
    [productId]
  );
  return !!row;
}

/**
 * Async sibling of productHasInventorySync for use outside a txn (e.g. catalog
 * display in the Telegram router). Same D3 semantics: counts rows in ANY status.
 */
export async function productHasInventory(productId) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT 1 AS hit FROM productCredentials WHERE productId = ? LIMIT 1`,
    [productId]
  );
  return !!row;
}

/**
 * Pick the oldest available credential for a product (FIFO).
 * SYNC — must be called inside a caller-owned db.transaction().
 * Returns a mapped credential object or null if the inventory is empty.
 */
export function getAvailableCredentialSync(adapter, productId) {
  return rowToCredential(
    adapter.get(
      `SELECT * FROM productCredentials WHERE productId = ? AND status = 'available' ORDER BY createdAt ASC LIMIT 1`,
      [productId]
    )
  );
}

/**
 * Mark a credential as delivered and link it to an order + item.
 * SYNC — must be called inside a caller-owned db.transaction().
 * Guards against double-delivery: the WHERE status='available' ensures only one
 * caller can succeed; any race or retry hits changes===0 and throws.
 */
export function deliverCredentialSync(adapter, credentialId, orderId, orderItemId, now) {
  const ts = now || new Date().toISOString();
  const res = adapter.run(
    `UPDATE productCredentials
     SET status = 'delivered', orderId = ?, orderItemId = ?, deliveredAt = ?, updatedAt = ?
     WHERE id = ? AND status = 'available'`,
    [orderId, orderItemId, ts, ts, credentialId]
  );
  if (!res || res.changes === 0) {
    throw new Error("deliverCredentialSync: credential " + credentialId + " is no longer available");
  }
  return rowToCredential(adapter.get(`SELECT * FROM productCredentials WHERE id = ?`, [credentialId]));
}

/**
 * Reserve the oldest available credential for a product (FIFO) inside the checkout txn.
 * SYNC — must be called inside a caller-owned db.transaction().
 * Atomically picks + flips status available→reserved with an order/item link. The
 * conditional UPDATE (status='available') makes concurrent reservers race-safe: only one
 * wins, the loser sees changes===0 and retries the SELECT for the next free row.
 * Returns the reserved credential (mapped) or null if inventory is exhausted.
 */
export function reserveCredentialSync(adapter, productId, orderId, orderItemId, now) {
  const ts = now || new Date().toISOString();
  // Retry loop: pick a candidate, try to claim it; if lost to a racer, pick the next.
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = adapter.get(
      `SELECT id FROM productCredentials WHERE productId = ? AND status = 'available' ORDER BY createdAt ASC LIMIT 1`,
      [productId]
    );
    if (!candidate) return null; // inventory empty
    const res = adapter.run(
      `UPDATE productCredentials
       SET status = 'reserved', orderId = ?, orderItemId = ?, reservedAt = ?, updatedAt = ?
       WHERE id = ? AND status = 'available'`,
      [orderId, orderItemId, ts, ts, candidate.id]
    );
    if (res && res.changes === 1) {
      return rowToCredential(adapter.get(`SELECT * FROM productCredentials WHERE id = ?`, [candidate.id]));
    }
    // lost the race — loop to grab the next available row
  }
  throw new Error("reserveCredentialSync: exhausted reservation attempts (high contention)");
}

/**
 * Reserve a SPECIFIC available credential by id (admin fulfillment, Story 2.28 QĐ5).
 * SYNC — must be called inside a caller-owned db.transaction().
 * Unlike reserveCredentialSync (FIFO by product), this claims the exact credential the
 * admin picked. The WHERE status='available' guard rejects an already-taken credential.
 * Returns the reserved credential (mapped). Throws if it is not available.
 */
export function reserveCredentialByIdSync(adapter, credentialId, orderId, orderItemId, now) {
  const ts = now || new Date().toISOString();
  const res = adapter.run(
    `UPDATE productCredentials
     SET status = 'reserved', orderId = ?, orderItemId = ?, reservedAt = ?, updatedAt = ?
     WHERE id = ? AND status = 'available'`,
    [orderId, orderItemId, ts, ts, credentialId]
  );
  if (!res || res.changes === 0) {
    throw new Error("reserveCredentialByIdSync: credential " + credentialId + " is not available");
  }
  return rowToCredential(adapter.get(`SELECT * FROM productCredentials WHERE id = ?`, [credentialId]));
}

/**
 * Release every reserved credential linked to an order back to `available` (Story 2.28 cancel).
 * SYNC — must be called inside a caller-owned db.transaction().
 * Only touches rows still in `reserved` (delivered/revoked are left untouched). Clears the
 * order link + reservedAt so the credential re-enters the FIFO pool. Returns the count released.
 */
export function releaseReservationSync(adapter, orderId, now) {
  const ts = now || new Date().toISOString();
  const res = adapter.run(
    `UPDATE productCredentials
     SET status = 'available', orderId = NULL, orderItemId = NULL, reservedAt = NULL, updatedAt = ?
     WHERE orderId = ? AND status = 'reserved'`,
    [ts, orderId]
  );
  return res?.changes ?? 0;
}

/**
 * Complete delivery of a previously reserved credential AFTER the checkout txn commits.
 * SYNC — flips status reserved→delivered, stamps deliveredAt.
 * The WHERE status='reserved' guards against double-completion. Throws if the credential
 * is not in the expected reserved state.
 */
export function completeDeliverySync(adapter, credentialId, now) {
  const ts = now || new Date().toISOString();
  const res = adapter.run(
    `UPDATE productCredentials
     SET status = 'delivered', deliveredAt = ?, updatedAt = ?
     WHERE id = ? AND status = 'reserved'`,
    [ts, ts, credentialId]
  );
  if (!res || res.changes === 0) {
    throw new Error("completeDeliverySync: credential " + credentialId + " is not in reserved state");
  }
  return rowToCredential(adapter.get(`SELECT * FROM productCredentials WHERE id = ?`, [credentialId]));
}

/**
 * List credentials linked to a given order (mapped — no payload exposed).
 * Used by admin fulfillment + order-detail views.
 */
export async function getCredentialsByOrderId(orderId) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM productCredentials WHERE orderId = ? ORDER BY createdAt ASC`,
    [orderId]
  );
  return rows.map(rowToCredential);
}

/**
 * Revoke a credential (admin action — marks it unusable, e.g. a compromised key).
 */
export async function revokeCredential(id, { note = null } = {}) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `UPDATE productCredentials SET status = 'revoked', note = COALESCE(?, note), updatedAt = ? WHERE id = ?`,
    [note, now, id]
  );
  return rowToCredential(db.get(`SELECT * FROM productCredentials WHERE id = ?`, [id]));
}

/**
 * Decrypt and return the plaintext payload for a credential.
 * Internal use only — called after commit to deliver to buyer. Never call from public API handlers.
 */
export async function getDecryptedPayload(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT payload FROM productCredentials WHERE id = ?`, [id]);
  if (!row) throw new Error(`getDecryptedPayload: credential ${id} not found`);
  console.info(`[credentialsRepo] getDecryptedPayload: credId=${id}`);
  return decrypt(row.payload);
}
