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

const _ipnCache = new Map();
export function cacheIpnData(gatewayPaymentId, raw) { _ipnCache.set(gatewayPaymentId, raw); }

export async function resolveSettlement(gatewayPaymentId) {
  const data = _ipnCache.get(gatewayPaymentId);
  if (!data) throw new Error(`[nowpayments-adapter] No cached IPN data for ${gatewayPaymentId}`);
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
