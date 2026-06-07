/**
 * NOWPayments API client — Story 2.8 Task 2 (AC2)
 * fetch (built-in Node 20+) + crypto (built-in). KHÔNG thêm SDK.
 */
import { createHmac, timingSafeEqual } from "crypto";

const NP_BASE = "https://api.nowpayments.io/v1";

/**
 * Coin+network → NOWPayments pay_currency code (arch §6.2)
 */
const COIN_NETWORK_MAP = {
  "USDT:tron": "usdttrc20",
  "USDT:ethereum": "usdterc20",
  "USDT:polygon": "usdtpolygon",
  "USDT:solana": "usdtsol",
  "USDC:ethereum": "usdcerc20",
  "USDC:polygon": "usdcpolygon",
  "USDC:solana": "usdcsol",
  "USDC:tron": "usdctrc20",
};

/**
 * Resolve NOWPayments pay_currency code from coin + network.
 * Throws if combination unsupported.
 */
export function getPayCurrencyCode(coin, network) {
  const key = `${(coin || "").toUpperCase()}:${(network || "").toLowerCase()}`;
  const code = COIN_NETWORK_MAP[key];
  if (!code) throw new Error(`Unsupported coin/network: ${coin}/${network}`);
  return code;
}

/**
 * Create a payment invoice via NOWPayments.
 * @param {{ amount: number, coin: string, network: string, orderId: string, baseUrl?: string }} opts
 * @returns {Promise<object>} NOWPayments invoice response
 */
export async function createInvoice({ amount, coin, network, orderId, baseUrl }) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) throw new Error("NOWPAYMENTS_API_KEY is not configured");

  const payCurrency = getPayCurrencyCode(coin, network);
  const callbackBase = baseUrl || process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:20128";

  const res = await fetch(`${NP_BASE}/invoice`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      price_amount: amount,
      price_currency: "usd",
      pay_currency: payCurrency,
      order_id: orderId,
      order_description: `9Router credit topup $${amount}`,
      ipn_callback_url: `${callbackBase}/api/webhooks/crypto`,
      success_url: `${callbackBase}/dashboard/credits?payment=success`,
      cancel_url: `${callbackBase}/dashboard/credits?payment=cancelled`,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NOWPayments API error ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Sort object keys alphabetically (deep: top-level only, per NOWPayments spec).
 */
function sortObjectKeys(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

/**
 * Verify NOWPayments IPN webhook signature (HMAC-SHA512, sorted keys).
 * @param {string} rawBody - raw JSON string of the request body
 * @param {string} signature - value of x-nowpayments-sig header
 * @param {string} secret - NOWPAYMENTS_IPN_SECRET
 * @returns {boolean}
 */
export function verifyIpnSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  let computed;
  try {
    const parsed = JSON.parse(rawBody);
    const sorted = JSON.stringify(sortObjectKeys(parsed));
    computed = createHmac("sha512", secret).update(sorted).digest("hex");
  } catch {
    // Malformed body (non-JSON) → treat as invalid signature, never throw.
    return false;
  }
  // Timing-safe compare. Buffers must be equal length or timingSafeEqual throws.
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
