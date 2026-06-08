/**
 * Payment provider registry — Story 2.9 Task 2 (AC1)
 */
import * as nowpaymentsAdapter from "../nowpayments-adapter.js";
import * as bitcart from "../bitcart.js";

const KNOWN_PROVIDERS = new Set(["auto", "nowpayments", "bitcart"]);

function bitcartConfigured() {
  // Require the webhook secret too: without it createInvoice throws and IPNs are
  // rejected 401, so a "configured" Bitcart that can't settle is not really usable.
  return Boolean(
    process.env.BITCART_BASE_URL &&
    process.env.BITCART_API_KEY &&
    process.env.BITCART_STORE_ID &&
    process.env.BITCART_WEBHOOK_SECRET
  );
}

/**
 * Select the active crypto payment provider.
 * @param {string} [override] - optional provider name (e.g. from cryptoPayment KV config)
 *   that takes precedence over the CRYPTO_PAYMENT_PROVIDER env var.
 */
export function getActiveProvider(override) {
  const raw = (override || process.env.CRYPTO_PAYMENT_PROVIDER || "auto").toLowerCase();
  const explicit = KNOWN_PROVIDERS.has(raw) ? raw : "auto";
  if (!KNOWN_PROVIDERS.has(raw))
    console.warn(`[payment/providers] Unknown provider "${raw}" — falling back to auto-detect`);

  if (explicit === "nowpayments") return nowpaymentsAdapter;
  if (explicit === "bitcart") return bitcart;
  if (process.env.NOWPAYMENTS_API_KEY) return nowpaymentsAdapter;
  if (bitcartConfigured()) return bitcart;
  return null;
}
