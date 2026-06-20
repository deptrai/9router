/**
 * Payment provider registry — Story 2.9 Task 2 (AC1), Story 2.39 (VND bank)
 */
import * as nowpaymentsAdapter from "../nowpayments-adapter.js";
import * as bitcart from "../bitcart.js";
import * as vndBank from "../vndBank.js";

const KNOWN_PROVIDERS = new Set(["auto", "nowpayments", "bitcart", "vnd_bank"]);

function bitcartConfigured() {
  return Boolean(
    process.env.BITCART_BASE_URL &&
    process.env.BITCART_API_KEY &&
    process.env.BITCART_STORE_ID &&
    process.env.BITCART_WEBHOOK_SECRET
  );
}

/**
 * Select the active crypto payment provider.
 */
export function getActiveProvider(override) {
  const raw = (override || process.env.CRYPTO_PAYMENT_PROVIDER || "auto").toLowerCase();
  const explicit = KNOWN_PROVIDERS.has(raw) ? raw : "auto";
  if (!KNOWN_PROVIDERS.has(raw))
    console.warn(`[payment/providers] Unknown provider "${raw}" — falling back to auto-detect`);

  if (explicit === "nowpayments") return nowpaymentsAdapter;
  if (explicit === "bitcart") return bitcart;
  if (explicit === "vnd_bank") return vndBank;
  if (process.env.NOWPAYMENTS_API_KEY) return nowpaymentsAdapter;
  if (bitcartConfigured()) return bitcart;
  return null;
}

/**
 * Get VND bank provider (independent of crypto provider selection).
 */
export function getVndBankProvider() {
  return vndBank.isConfigured() ? vndBank : null;
}

/**
 * Get available payment methods for topup.
 */
export function getAvailableMethods() {
  const methods = [];
  if (bitcartConfigured() || process.env.NOWPAYMENTS_API_KEY) {
    methods.push("crypto");
  }
  if (vndBank.isConfigured()) {
    methods.push("vnd_bank");
  }
  return methods;
}
