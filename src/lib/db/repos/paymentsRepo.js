import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    gatewayPaymentId: row.gatewayPaymentId || null,
    gatewayInvoiceId: row.gatewayInvoiceId || null,
    txHash: row.txHash || null,
    network: row.network,
    coin: row.coin,
    amountExpected: row.amountExpected,
    amountReceived: row.amountReceived ?? null,
    creditsAwarded: row.creditsAwarded ?? null,
    bonusPercent: row.bonusPercent ?? 0,
    status: row.status,
    payAddress: row.payAddress || null,
    paymentUrl: row.paymentUrl || null,
    confirmations: row.confirmations ?? 0,
    expiresAt: row.expiresAt || null,
    settledAt: row.settledAt || null,
    errorMessage: row.errorMessage || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createPayment(data) {
  const db = await getAdapter();
  const id = data.id || uuidv4();
  const now = new Date().toISOString();
  const payment = {
    id,
    userId: data.userId,
    gatewayPaymentId: data.gatewayPaymentId || null,
    gatewayInvoiceId: data.gatewayInvoiceId || null,
    txHash: data.txHash || null,
    network: data.network,
    coin: data.coin,
    amountExpected: data.amountExpected,
    amountReceived: data.amountReceived ?? null,
    creditsAwarded: data.creditsAwarded ?? null,
    bonusPercent: data.bonusPercent ?? 0,
    status: data.status || "pending",
    payAddress: data.payAddress || null,
    paymentUrl: data.paymentUrl || null,
    confirmations: data.confirmations ?? 0,
    expiresAt: data.expiresAt || null,
    settledAt: data.settledAt || null,
    errorMessage: data.errorMessage || null,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO payments(id, userId, gatewayPaymentId, gatewayInvoiceId, txHash, network, coin, amountExpected, amountReceived, creditsAwarded, bonusPercent, status, payAddress, paymentUrl, confirmations, expiresAt, settledAt, errorMessage, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [payment.id, payment.userId, payment.gatewayPaymentId, payment.gatewayInvoiceId, payment.txHash, payment.network, payment.coin, payment.amountExpected, payment.amountReceived, payment.creditsAwarded, payment.bonusPercent, payment.status, payment.payAddress, payment.paymentUrl, payment.confirmations, payment.expiresAt, payment.settledAt, payment.errorMessage, payment.createdAt, payment.updatedAt]
  );
  return payment;
}

export async function getPaymentById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM payments WHERE id = ?`, [id]);
  return rowToPayment(row);
}

export async function getPaymentByGatewayId(gatewayPaymentId) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM payments WHERE gatewayPaymentId = ?`, [gatewayPaymentId]);
  return rowToPayment(row);
}

export async function updatePayment(id, data) {
  const db = await getAdapter();
  // Filter undefined (bài học story 2.1)
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined)
  );
  if (Object.keys(clean).length === 0) return null;

  const now = new Date().toISOString();
  let result = null;

  db.transaction(() => {
    const row = db.get(`SELECT * FROM payments WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToPayment(row), ...clean, updatedAt: now };
    db.run(
      `UPDATE payments SET gatewayPaymentId=?, gatewayInvoiceId=?, txHash=?, network=?, coin=?, amountExpected=?, amountReceived=?, creditsAwarded=?, bonusPercent=?, status=?, payAddress=?, paymentUrl=?, confirmations=?, expiresAt=?, settledAt=?, errorMessage=?, updatedAt=? WHERE id=?`,
      [merged.gatewayPaymentId, merged.gatewayInvoiceId, merged.txHash, merged.network, merged.coin, merged.amountExpected, merged.amountReceived, merged.creditsAwarded, merged.bonusPercent, merged.status, merged.payAddress, merged.paymentUrl, merged.confirmations, merged.expiresAt, merged.settledAt, merged.errorMessage, merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function listPayments({ userId, status, limit = 50, offset = 0 } = {}) {
  const db = await getAdapter();
  let sql = `SELECT * FROM payments`;
  const conds = [];
  const params = [];

  if (userId) { conds.push(`userId = ?`); params.push(userId); }
  if (status) { conds.push(`status = ?`); params.push(status); }

  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.all(sql, params);
  return rows.map(rowToPayment);
}

export async function getPaymentsByUser(userId) {
  return listPayments({ userId });
}
