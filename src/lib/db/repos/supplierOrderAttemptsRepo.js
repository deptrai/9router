// Story 2-38.2: audit trail of fallback attempts for auto_fulfill orders.

import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.orderId,
    supplierSourceId: row.supplierSourceId,
    supplierProductId: row.supplierProductId ?? null,
    supplierPrice: row.supplierPrice ?? null,
    attemptIndex: row.attemptIndex ?? 0,
    status: row.status,
    error: row.error ?? null,
    createdAt: row.createdAt,
  };
}

export function insertAttemptSync(adapter, data) {
  const now = data.now || new Date().toISOString();
  const id = data.id || uuidv4();
  adapter.run(
    `INSERT INTO supplierOrderAttempts(
      id, orderId, supplierSourceId, supplierProductId, supplierPrice,
      attemptIndex, status, error, createdAt
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.orderId,
      data.supplierSourceId,
      data.supplierProductId ?? null,
      data.supplierPrice ?? null,
      data.attemptIndex ?? 0,
      data.status,
      data.error ?? null,
      now,
    ]
  );
  return rowToAttempt({ ...data, id, createdAt: now });
}

export async function listAttemptsByOrder(orderId) {
  const adapter = await getAdapter();
  const rows = adapter.all(
    `SELECT * FROM supplierOrderAttempts WHERE orderId = ? ORDER BY attemptIndex ASC`,
    [orderId]
  );
  return rows.map(rowToAttempt);
}

export function updateAttemptStatusSync(adapter, id, { status, error, attemptIndex }) {
  const fields = [];
  const values = [];
  if (status !== undefined) {
    fields.push("status = ?");
    values.push(status);
  }
  if (error !== undefined) {
    fields.push("error = ?");
    values.push(error ?? null);
  }
  if (attemptIndex !== undefined) {
    fields.push("attemptIndex = ?");
    values.push(attemptIndex);
  }
  if (!fields.length) return null;
  values.push(id);
  adapter.run(`UPDATE supplierOrderAttempts SET ${fields.join(", ")} WHERE id = ?`, values);
  return rowToAttempt(adapter.get(`SELECT * FROM supplierOrderAttempts WHERE id = ?`, [id]));
}
