/**
 * Payment provider registry — Story 2.9 Task 2 (AC1)
 */
import * as nowpaymentsAdapter from "../nowpayments-adapter.js";
import * as bitcart from "../bitcart.js";

export function getActiveProvider() {
  const explicit = (process.env.CRYPTO_PAYMENT_PROVIDER || "auto").toLowerCase();
  if (explicit === "nowpayments") return nowpaymentsAdapter;
  if (explicit === "bitcart") return bitcart;
  if (process.env.NOWPAYMENTS_API_KEY) return nowpaymentsAdapter;
  if (
    process.env.BITCART_BASE_URL &&
    process.env.BITCART_API_KEY &&
    process.env.BITCART_STORE_ID
  ) return bitcart;
  return null;
}
