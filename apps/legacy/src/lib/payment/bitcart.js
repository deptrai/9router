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

// 9router network name -> Bitcart wallet currency
const NETWORK_CURRENCY = {
  tron: "trx",
  bsc: "bnb",
  binance: "bnb",
  ethereum: "eth",
  polygon: "matic",
  solana: "sol",
};

// Token contract per (coin, chain). Only stablecoins we actually support.
const TOKEN_CONTRACTS = {
  "usdt:trx": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  "usdt:bnb": "0x55d398326f99059ff775485246999027b3197955",
  "usdc:trx": "TEkxiTehnzwnq8R2fmj5tSNTx8bxiuYDA", // USDC on Tron (Tether-issued)
  "usdc:bnb": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
};

// In-memory wallet list cache. TTL = 60s. Safe because wallets change rarely.
let walletCache = { data: null, fetchedAt: 0 };
const WALLET_CACHE_TTL_MS = 60_000;

function normalizeContract(c) {
  return (c || "").toLowerCase().replace(/^0x/, "0x");
}

async function fetchWallets({ baseUrl, apiKey }, signal) {
  const now = Date.now();
  if (walletCache.data && now - walletCache.fetchedAt < WALLET_CACHE_TTL_MS) {
    return walletCache.data;
  }
  const res = await fetch(`${baseUrl}/wallets`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bitcart fetchWallets error ${res.status}: ${text}`);
  }
  const body = await res.json();
  const wallets = Array.isArray(body) ? body : body?.result || [];
  walletCache = { data: wallets, fetchedAt: now };
  return wallets;
}

function selectWalletId(wallets, coin, network) {
  const networkLower = (network || "").toLowerCase();
  const desiredCurrency = NETWORK_CURRENCY[networkLower];
  if (!desiredCurrency) {
    throw new Error(`Bitcart does not support network: ${network}`);
  }
  const coinLower = (coin || "").toLowerCase();
  const isNative = coinLower === desiredCurrency;
  const desiredContract = isNative
    ? ""
    : (TOKEN_CONTRACTS[`${coinLower}:${desiredCurrency}`] || "").toLowerCase();
  if (!isNative && !desiredContract) {
    throw new Error(`Bitcart does not support ${coin} on ${network}`);
  }

  const w = wallets.find((wallet) => {
    const wc = (wallet.currency || "").toLowerCase();
    const wContract = normalizeContract(wallet.contract);
    return wc === desiredCurrency && wContract === desiredContract;
  });
  if (!w) {
    throw new Error(`Bitcart wallet not found for ${coin} on ${network}`);
  }
  return w.id;
}

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

export async function cancelInvoice(gatewayId) {
  const { baseUrl, apiKey } = getConfig();
  if (!gatewayId) throw new Error("Bitcart cancelInvoice requires gatewayId");
  const res = await fetch(`${baseUrl}/invoices/${gatewayId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bitcart cancelInvoice error ${res.status}: ${text}`);
  }
  return true;
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
  const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
  const amountReceived = payments.reduce((sum, p) => {
    const n = Number(p?.amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  const txHash = payments.find((p) => p?.lookup_field || p?.tx_hash)?.lookup_field || payments.find((p) => p?.lookup_field || p?.tx_hash)?.tx_hash || null;
  const confirmations = Math.max(0, ...payments.map((p) => Number(p?.confirmations) || 0));
  // Bitcart marked the invoice complete but the re-fetched invoice has no usable
  // payment amount (empty payments[] or a partial/buggy API response). Throwing here
  // makes the webhook return 500 so Bitcart retries, rather than settling for 0 credits.
  if (amountReceived <= 0)
    throw new Error(`Bitcart invoice ${gatewayId} settled with no payment amount`);
  return {
    amountReceived,
    txHash,
    confirmations,
  };
}

export async function createInvoice({ amount, coin, network, orderId, signal }) {
  const { baseUrl, apiKey, storeId } = getConfig();
  const secret = process.env.BITCART_WEBHOOK_SECRET;
  // Without the webhook secret the notification_url carries no token, so every IPN
  // Bitcart sends would be rejected 401 by verifyAuth and the payment could never
  // settle. Fail loudly at create time instead of silently stranding payments.
  if (!secret)
    throw new Error("Bitcart not configured: BITCART_WEBHOOK_SECRET is required");
  const base = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:20128";
  const notifUrl = `${base}/api/webhooks/bitcart?token=${encodeURIComponent(secret)}`;

  const internal = new AbortController();
  const t = setTimeout(() => internal.abort(new Error("bitcart createInvoice timeout")), 15_000);
  let fetchSignal = internal.signal;
  if (signal) {
    fetchSignal = typeof AbortSignal.any === "function" ? AbortSignal.any([internal.signal, signal]) : signal;
  }

  let walletId;
  try {
    const wallets = await fetchWallets({ baseUrl, apiKey }, fetchSignal);
    walletId = selectWalletId(wallets, coin, network);
  } catch (err) {
    clearTimeout(t);
    throw new Error(`Bitcart wallet selection failed: ${err.message}`);
  }

  let res;
  try {
    res = await fetch(`${baseUrl}/invoices`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        store_id: storeId,
        price: amount,
        currency: "USD",
        order_id: orderId,
        notification_url: notifUrl,
        payment_methods: [walletId],
      }),
      signal: fetchSignal,
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
