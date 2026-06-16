// supplierDeliveriesRepo — append-only delivery audit trail (Story 2.33)
//
// Metadata only — NO payload column (NFR8/D6/AC3).
// status: forwarded|forward_failed|unsupported
// deliveryType: text|credential|file|message|image|unknown

import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    supplierOrderId: row.supplierOrderId,
    orderId: row.orderId,
    deliveryType: row.deliveryType ?? null,
    status: row.status,
    note: row.note ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Insert a delivery audit row. MUST be called inside a caller-owned transaction.
 * Does NOT accept or store payload — audit metadata only.
 * @param {object} adapter - db adapter inside an open transaction
 * @param {object} data - { supplierOrderId, orderId, deliveryType?, status, note?, now? }
 * @returns {object} the inserted row (mapped)
 */
export function insertDeliverySync(adapter, { supplierOrderId, orderId, deliveryType, status, note, now } = {}) {
  const id = uuidv4();
  const createdAt = now || new Date().toISOString();
  adapter.run(
    `INSERT INTO supplierDeliveries(id, supplierOrderId, orderId, deliveryType, status, note, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [id, supplierOrderId, orderId, deliveryType ?? null, status, note ?? null, createdAt]
  );
  return rowToDelivery({ id, supplierOrderId, orderId, deliveryType, status, note, createdAt });
}

/**
 * Check if a delivery has already been successfully forwarded for this supplierOrderId.
 * Used for idempotency — prevents double-sending the same payload (QĐ8).
 * MUST be called inside a caller-owned transaction.
 * @param {object} adapter - db adapter inside an open transaction
 * @param {string} supplierOrderId
 * @returns {boolean}
 */
export function hasForwardedDeliverySync(adapter, supplierOrderId) {
  const row = adapter.get(
    `SELECT 1 AS hit FROM supplierDeliveries WHERE supplierOrderId = ? AND status = 'forwarded' LIMIT 1`,
    [supplierOrderId]
  );
  return !!row;
}

/**
 * List delivery audit rows for an order — admin view (2.34).
 * @param {string} orderId
 * @returns {Promise<object[]>}
 */
export async function listDeliveriesByOrder(orderId) {
  const adapter = await getAdapter();
  const rows = adapter.all(
    `SELECT * FROM supplierDeliveries WHERE orderId = ? ORDER BY createdAt ASC`,
    [orderId]
  );
  return rows.map(rowToDelivery);
}
