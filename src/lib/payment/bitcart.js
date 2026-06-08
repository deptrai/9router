/**
 * Bitcart provider adapter — Story 2.9 Task 3 (AC2)
 * Unsigned IPN + shared-secret token in notification_url.
 * Uses built-in fetch + crypto. No new npm deps.
 */
import { timingSafeEqual } from "crypto";

function getConfig() {
  const baseUrl = process.env.BITCART_BASE_URL;
  const apiKey = process.env.BITCART_API_KEY;
  const storeId = process.env.BITCART_STORE_ID;
  if (!baseUrl || !apiKey || !storeId)
    throw new Error("Bitcart not configured: BITCART_BASE_URL, BITCART_API_KEY, and BITCART_STORE_ID are required");
  return { baseUrl, apiKey, storeId };
}

const STATUS_MAP = {
  pending: "pending", paid: "pending", unconfirmed: "confirming",
  confirmed: "confirming", complete: "settled", expired: "expired",
  invalid: "failed", refunded: "failed",
};

export function getProviderName() { return "bitcart"; }

export function verifyAuth(req, _rawBody) {
  const secret = process.env.BITCART_WEBHOOK_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  if (!token) return false;
  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseIpn(rawBody) {
  const data = JSON.parse(rawBody);
  return {
    gatewayPaymentId: String(data.id || ""),
    internalStatus: STATUS_MAP[(data.status || "").toLowerCase()] || null,
  };
}

export async function getInvoice(gatewayId) {
  const { baseUrl, apiKey } = getConfig();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  let res;
  try {
    res = await fetch(`${baseUrl}/invoices/${gatewayId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
  if (!res.ok) { const text = await res.text().catch(() => ""); throw new Error(`Bitcart API error ${res.status}: ${text}`); }
  return res.json();
}

export async function resolveSettlement(gatewayId) {
  const invoice = await getInvoice(gatewayId);
  const p = (invoice.payments || [])[0] || {};
  const amountReceived = Number(p.amount) || 0;
  // Bitcart marked the invoice complete but the re-fetched invoice has no usable
  // payment amount (empty payments[] or a partial/buggy API response). Throwing here
  // makes the webhook return 500 so Bitcart retries, rather than settling for 0 credits.
  if (amountReceived <= 0)
    throw new Error(`Bitcart invoice ${gatewayId} settled with no payment amount`);
  return {
    amountReceived,
    txHash: p.lookup_field || p.tx_hash || null,
    confirmations: Number(p.confirmations) || 0,
  };
}

export async function createInvoice({ amount, coin, network, orderId }) {
  const { baseUrl, apiKey, storeId } = getConfig();
  const secret = process.env.BITCART_WEBHOOK_SECRET;
  // Without the webhook secret the notification_url carries no token, so every IPN
  // Bitcart sends would be rejected 401 by verifyAuth and the payment could never
  // settle. Fail loudly at create time instead of silently stranding payments.
  if (!secret)
    throw new Error("Bitcart not configured: BITCART_WEBHOOK_SECRET is required");
  const base = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:20128";
  const notifUrl = `${base}/api/webhooks/bitcart?token=${encodeURIComponent(secret)}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  let res;
  try {
    res = await fetch(`${baseUrl}/invoices`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ store_id: storeId, price: amount, currency: "USD", order_id: orderId, notification_url: notifUrl }),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
  if (!res.ok) { const text = await res.text().catch(() => ""); throw new Error(`Bitcart createInvoice error ${res.status}: ${text}`); }
  const inv = await res.json();
  // Guard against a falsy id: String(null)/String(undefined) would store the literal
  // "null"/"undefined" as gatewayPaymentId (a UNIQUE column) and collide on the next such row.
  if (!inv.id) throw new Error("Bitcart createInvoice returned no invoice id");
  const pm = (inv.payments || [])[0] || {};
  return {
    gatewayId: String(inv.id),
    paymentUrl: pm.payment_url || null,
    payAddress: pm.payment_address || null,
    amountExpected: amount,
    expiresAt: inv.expiration || inv.time_left || null,
  };
}
