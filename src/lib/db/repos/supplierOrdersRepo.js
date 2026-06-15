// supplierOrdersRepo — tracking table for supplier-side orders (Story 2.32)
//
// Each internal order for an external product has ≥1 supplierOrders row.
// supplierOrderId/supplierInvoiceId/qrPayload are null at creation for proxy_checkout
// (filled by admin/sync after placing upstream order, or by vendor adapter in 2.33+).

import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToSupplierOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.orderId,
    supplierSourceId: row.supplierSourceId,
    supplierProductId: row.supplierProductId ?? null,
    paymentMode: row.paymentMode,
    supplierOrderId: row.supplierOrderId ?? null,
    supplierInvoiceId: row.supplierInvoiceId ?? null,
    qrPayload: row.qrPayload ?? null,
    supplierPrice: row.supplierPrice ?? null,
    retailPrice: row.retailPrice ?? null,
    expectedMargin: row.expectedMargin ?? null,
    supplierStatus: row.supplierStatus ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Insert a supplierOrders row. MUST be called inside a caller-owned transaction.
 * Pass the same adapter the caller's transaction uses (E7 inline-transaction pattern).
 * @param {object} adapter - db adapter inside an open transaction
 * @param {object} data - { orderId, supplierSourceId, supplierProductId?, paymentMode,
 *                          supplierPrice?, retailPrice?, expectedMargin?, now? }
 * @returns {object} the inserted row (mapped)
 */
export function insertSupplierOrderSync(adapter, data) {
  const now = data.now || new Date().toISOString();
  const id = data.id || uuidv4();
  adapter.run(
    `INSERT INTO supplierOrders(
      id, orderId, supplierSourceId, supplierProductId, paymentMode,
      supplierOrderId, supplierInvoiceId, qrPayload,
      supplierPrice, retailPrice, expectedMargin, supplierStatus,
      createdAt, updatedAt
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.orderId,
      data.supplierSourceId,
      data.supplierProductId ?? null,
      data.paymentMode,
      null, // supplierOrderId — filled later by admin/sync
      null, // supplierInvoiceId
      null, // qrPayload
      data.supplierPrice ?? null,
      data.retailPrice ?? null,
      data.expectedMargin ?? null,
      null, // supplierStatus
      now,
      now,
    ]
  );
  return rowToSupplierOrder({ ...data, id, createdAt: now, updatedAt: now });
}

/**
 * Idempotency recheck — call inside transaction before insertSupplierOrderSync.
 * Returns existing row if orderId already has a supplierOrders entry, else null.
 * @param {object} adapter - db adapter inside an open transaction
 * @param {string} orderId
 * @returns {object|null}
 */
export function getSupplierOrderByOrderIdSync(adapter, orderId) {
  const row = adapter.get(
    `SELECT * FROM supplierOrders WHERE orderId = ? LIMIT 1`,
    [orderId]
  );
  return rowToSupplierOrder(row);
}

/**
 * Async lookup by internal orderId.
 * @param {string} orderId
 * @returns {Promise<object|null>}
 */
export async function getSupplierOrderByOrderId(orderId) {
  const adapter = await getAdapter();
  const row = adapter.get(
    `SELECT * FROM supplierOrders WHERE orderId = ? LIMIT 1`,
    [orderId]
  );
  return rowToSupplierOrder(row);
}

/**
 * Update supplier-side fields after placing upstream order or receiving status sync (2.33).
 * @param {string} id - supplierOrders.id
 * @param {object} fields - { supplierOrderId?, supplierInvoiceId?, qrPayload?, supplierStatus? }
 * @returns {Promise<object|null>}
 */
export async function updateSupplierOrderStatus(id, { supplierOrderId, supplierInvoiceId, qrPayload, supplierStatus } = {}) {
  const adapter = await getAdapter();
  const now = new Date().toISOString();
  adapter.run(
    `UPDATE supplierOrders
     SET supplierOrderId   = COALESCE(?, supplierOrderId),
         supplierInvoiceId = COALESCE(?, supplierInvoiceId),
         qrPayload         = COALESCE(?, qrPayload),
         supplierStatus    = COALESCE(?, supplierStatus),
         updatedAt         = ?
     WHERE id = ?`,
    [
      supplierOrderId ?? null,
      supplierInvoiceId ?? null,
      qrPayload ?? null,
      supplierStatus ?? null,
      now,
      id,
    ]
  );
  const row = adapter.get(`SELECT * FROM supplierOrders WHERE id = ?`, [id]);
  return rowToSupplierOrder(row);
}

/**
 * List supplier orders — admin view (2.34) or status sync (2.33).
 * @param {object} opts - { supplierSourceId?, supplierStatus?, limit?, offset? }
 * @returns {Promise<object[]>}
 */
export async function listSupplierOrders({ supplierSourceId, supplierStatus, limit = 20, offset = 0 } = {}) {
  const adapter = await getAdapter();
  const clauses = [];
  const params = [];
  if (supplierSourceId) {
    clauses.push("supplierSourceId = ?");
    params.push(supplierSourceId);
  }
  if (supplierStatus) {
    clauses.push("supplierStatus = ?");
    params.push(supplierStatus);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = adapter.all(
    `SELECT * FROM supplierOrders ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows.map(rowToSupplierOrder);
}

/**
 * Find paid external orders that are missing a supplierOrders row (orphan detection).
 * Used by reconciliation sweep (2.34) and orphan-recovery retry path.
 * Joins orders → orderItems → products → LEFT JOIN supplierOrders.
 * @returns {Promise<object[]>} array of orders rows (without items) that need recovery
 */
export async function findPaidExternalOrdersMissingSupplierOrder() {
  const adapter = await getAdapter();
  const rows = adapter.all(
    `SELECT DISTINCT o.*
     FROM orders o
     JOIN orderItems oi ON oi.orderId = o.id
     JOIN products p ON p.id = oi.productId
     LEFT JOIN supplierOrders so ON so.orderId = o.id
     WHERE o.status = 'paid'
       AND p.source = 'external_telegram_store'
       AND so.id IS NULL`
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    status: r.status,
    source: r.source,
    totalCredits: r.totalCredits ?? 0,
    deliveryMode: r.deliveryMode ?? null,
    ledgerTxnId: r.ledgerTxnId ?? null,
    idempotencyKey: r.idempotencyKey ?? null,
    note: r.note ?? null,
    fulfilledAt: r.fulfilledAt ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}
