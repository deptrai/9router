/**
 * ordersRepo — Telegram Store orders (Story 2.26)
 *
 * State machine: pending → paid → fulfilled
 *                              ↘ cancelled | failed | refunded
 *
 * For a credit-paid store purchase, the order is created already in `paid`
 * (credit debited atomically in the same db.transaction via storeCheckout), then
 * transitioned to `fulfilled` for instant delivery or kept `paid` for admin_fulfill.
 *
 * orderItems snapshot product fields (name/price/kind/delivery) at purchase time so
 * later catalog edits never mutate a completed sale.
 */

import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

export const ORDER_STATUSES = ["pending", "paid", "fulfilled", "cancelled", "failed", "refunded"];

// Allowed forward transitions. Terminal states have no outgoing edges.
const ALLOWED_TRANSITIONS = {
  pending: ["paid", "cancelled", "failed"],
  paid: ["fulfilled", "cancelled", "failed", "refunded"],
  fulfilled: ["refunded"],
  cancelled: [],
  failed: [],
  refunded: [],
};

export function canTransition(from, to) {
  if (!ORDER_STATUSES.includes(to)) return false;
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    source: row.source,
    totalCredits: row.totalCredits ?? 0,
    deliveryMode: row.deliveryMode ?? null,
    ledgerTxnId: row.ledgerTxnId ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.orderId,
    productId: row.productId,
    productName: row.productName,
    kind: row.kind,
    deliveryMode: row.deliveryMode,
    targetType: row.targetType ?? null,
    targetId: row.targetId ?? null,
    unitCredits: row.unitCredits,
    quantity: row.quantity ?? 1,
    createdAt: row.createdAt,
  };
}

/**
 * Insert an order + its line items. MUST be called inside a db.transaction()
 * owned by the caller (storeCheckout) so the credit debit and order row commit
 * atomically. Pass the same adapter the caller's transaction uses.
 *
 * @param {object} adapter - db adapter inside an open transaction
 * @param {object} order - { id?, userId, status?, source?, totalCredits, deliveryMode, ledgerTxnId?, idempotencyKey?, note?, now? }
 * @param {Array}  items - [{ productId, productName, kind, deliveryMode, targetType?, targetId?, unitCredits, quantity? }]
 * @returns {{ order, items }}
 */
export function insertOrderWithItems(adapter, order, items) {
  const now = order.now || new Date().toISOString();
  const id = order.id || uuidv4();
  const status = order.status || "pending";
  if (!ORDER_STATUSES.includes(status)) {
    throw new Error(`insertOrderWithItems: invalid status ${status}`);
  }
  adapter.run(
    `INSERT INTO orders(id, userId, status, source, totalCredits, deliveryMode, ledgerTxnId, idempotencyKey, note, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      order.userId,
      status,
      order.source || "telegram",
      order.totalCredits ?? 0,
      order.deliveryMode ?? null,
      order.ledgerTxnId ?? null,
      order.idempotencyKey ?? null,
      order.note ?? null,
      now,
      now,
    ]
  );

  const savedItems = [];
  for (const it of items || []) {
    const itemId = it.id || uuidv4();
    adapter.run(
      `INSERT INTO orderItems(id, orderId, productId, productName, kind, deliveryMode, targetType, targetId, unitCredits, quantity, createdAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        itemId,
        id,
        it.productId,
        it.productName,
        it.kind,
        it.deliveryMode,
        it.targetType ?? null,
        it.targetId ?? null,
        it.unitCredits,
        it.quantity ?? 1,
        now,
      ]
    );
    savedItems.push(rowToItem({ ...it, id: itemId, orderId: id, createdAt: now }));
  }

  return { order: rowToOrder({ ...order, id, status, source: order.source || "telegram", createdAt: now, updatedAt: now }), items: savedItems };
}

/**
 * Transition an order's status with state-machine validation (sync).
 * Use this inside a caller-owned db.transaction(); pass that same adapter.
 * @param {object} adapter - db adapter (typically inside an open transaction)
 * @param {string} orderId
 * @param {string} toStatus
 * @returns {object} the updated order (mapped)
 */
export function transitionOrderSync(adapter, orderId, toStatus, { note = null } = {}) {
  const row = adapter.get(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!row) throw new Error(`transitionOrder: order ${orderId} not found`);
  if (row.status === toStatus) return rowToOrder(row); // idempotent no-op
  if (!canTransition(row.status, toStatus)) {
    throw new Error(`transitionOrder: illegal ${row.status} → ${toStatus}`);
  }
  const now = new Date().toISOString();
  adapter.run(
    `UPDATE orders SET status = ?, note = COALESCE(?, note), updatedAt = ? WHERE id = ?`,
    [toStatus, note, now, orderId]
  );
  return rowToOrder({ ...row, status: toStatus, note: note ?? row.note, updatedAt: now });
}

/**
 * Transition an order's status with its own adapter. Always async — awaitable
 * with a consistent return type (Promise<order>).
 * @param {string} orderId
 * @param {string} toStatus
 * @returns {Promise<object>} the updated order (mapped)
 */
export async function transitionOrder(orderId, toStatus, { note = null } = {}) {
  const adapter = await getAdapter();
  return transitionOrderSync(adapter, orderId, toStatus, { note });
}

/**
 * Sync lookup by idempotencyKey, mapped. Use inside a caller-owned transaction;
 * pass that same adapter so the read sees uncommitted in-txn writes.
 * @param {object} adapter
 * @param {string} idempotencyKey
 * @returns {{...order, items}|null}
 */
export function getOrderByIdempotencyKeySync(adapter, idempotencyKey) {
  if (!idempotencyKey) return null;
  const order = rowToOrder(adapter.get(`SELECT * FROM orders WHERE idempotencyKey = ?`, [idempotencyKey]));
  if (!order) return null;
  const items = adapter.all(`SELECT * FROM orderItems WHERE orderId = ?`, [order.id]).map(rowToItem);
  return { ...order, items };
}

export async function getOrderById(id) {
  const adapter = await getAdapter();
  const order = rowToOrder(adapter.get(`SELECT * FROM orders WHERE id = ?`, [id]));
  if (!order) return null;
  const items = adapter.all(`SELECT * FROM orderItems WHERE orderId = ?`, [id]).map(rowToItem);
  return { ...order, items };
}

export async function getOrderByIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey) return null;
  const adapter = await getAdapter();
  const order = rowToOrder(adapter.get(`SELECT * FROM orders WHERE idempotencyKey = ?`, [idempotencyKey]));
  if (!order) return null;
  const items = adapter.all(`SELECT * FROM orderItems WHERE orderId = ?`, [order.id]).map(rowToItem);
  return { ...order, items };
}

export async function listOrdersByUser(userId, { limit = 20, offset = 0 } = {}) {
  const adapter = await getAdapter();
  const rows = adapter.all(
    `SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  return rows.map(rowToOrder);
}
