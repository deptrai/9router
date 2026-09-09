/**
 * Payment provider registry — Story 2.9 Task 2 (AC1), Story 2.39 (VND bank)
 */
import * as nowpaymentsAdapter from "../nowpayments-adapter.js";
import * as bitcart from "../bitcart.js";
import * as vndBank from "../vndBank.js";

const KNOWN_PROVIDERS = new Set(["auto", "nowpayments", "bitcart"]);

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
 * Note: vnd_bank is NOT a crypto provider — use getVndBankProvider() for VND.
 */
export function getActiveProvider(override) {
  const raw = (override || process.env.CRYPTO_PAYMENT_PROVIDER || "auto").toLowerCase();
  if (raw === "vnd_bank") {
    console.warn(`[payment/providers] vnd_bank is not a crypto provider — use getVndBankProvider() instead. Falling back to auto-detect.`);
  }
  const explicit = KNOWN_PROVIDERS.has(raw) ? raw : "auto";
  if (!KNOWN_PROVIDERS.has(raw) && raw !== "vnd_bank")
    console.warn(`[payment/providers] Unknown provider "${raw}" — falling back to auto-detect`);

  if (explicit === "nowpayments") return nowpaymentsAdapter;
  if (explicit === "bitcart") return bitcart;
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
