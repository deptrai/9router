/**
 * NOWPayments provider adapter — Story 2.9 Task 2 (AC1)
 * Wraps nowpayments.js to match provider interface.
 */
import { createInvoice as npCreateInvoice, verifyIpnSignature } from "./nowpayments.js";

const STATUS_MAP = {
  waiting: "pending", confirming: "confirming", confirmed: "confirmed",
  sending: "confirmed", finished: "settled", partially_paid: "confirming",
  failed: "failed", expired: "expired", refunded: "failed",
};

export function getProviderName() { return "nowpayments"; }

export function verifyAuth(req, rawBody) {
  const signature = req.headers.get("x-nowpayments-sig");
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  return verifyIpnSignature(rawBody, signature, secret);
}

export function parseIpn(rawBody) {
  const data = JSON.parse(rawBody);
  return {
    gatewayPaymentId: String(data.payment_id || ""),
    internalStatus: STATUS_MAP[(data.payment_status || "").toLowerCase()] || null,
    _raw: data,
  };
}

// Pass IPN data directly instead of caching in a module-level Map.
// The Map pattern was fragile: a serverless restart between cacheIpnData and
// resolveSettlement would silently lose the data. Since both calls happen in the
// same request handler, passing data directly is strictly safer (R3-P1-4).
export function resolveSettlement(_gatewayPaymentId, data) {
  if (!data) throw new Error(`[nowpayments-adapter] No IPN data provided for ${_gatewayPaymentId}`);
  return {
    amountReceived: Number(data.actually_paid) || Number(data.pay_amount) || 0,
    txHash: data.payin_hash || data.purchase_id || null,
    confirmations: Number(data.confirmations) || 0,
  };
}

export async function createInvoice({ amount, coin, network, orderId }) {
  const invoice = await npCreateInvoice({ amount, coin, network, orderId });
  return {
    gatewayId: String(invoice.id),
    paymentUrl: invoice.invoice_url || null,
    payAddress: invoice.pay_address || null,
    amountExpected: amount,
    expiresAt: invoice.expiration_estimate_date || null,
  };
}
