/**
 * vndBank.js — VND bank transfer payment provider (Story 2-39)
 *
 * Generate VietQR (EMVCo format) cho personal bank account.
 * Verify SePay webhook IPN để auto-confirm payment.
 */

import crypto from "node:crypto";

const VND_PER_CREDIT = () => Number(process.env.VND_PER_CREDIT || 1000);
const BANK_ACCOUNT = () => process.env.VND_BANK_ACCOUNT || "";
const BANK_BIN = () => process.env.VND_BANK_BIN || "";
const BANK_NAME = () => process.env.VND_BANK_NAME || "";
const WEBHOOK_SECRET = () => process.env.SEPAY_WEBHOOK_SECRET || "";
const PAYMENT_TIMEOUT_MS = 30 * 60 * 1000;

export function isConfigured() {
  return !!(BANK_ACCOUNT() && BANK_BIN());
}

export function generateMemo() {
  return "9R" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

export function creditsToVnd(credits) {
  return Math.ceil(credits * VND_PER_CREDIT());
}

export function vndToCredits(amountVnd) {
  return Math.floor(amountVnd / VND_PER_CREDIT());
}

/**
 * Generate VietQR data string (EMVCo QR format for NAPAS interbank transfer)
 */
export function generateVietQR({ amount, memo }) {
  const bankBin = BANK_BIN();
  const accountNo = BANK_ACCOUNT();

  // Build TLV fields
  const merchantAccInfo = buildTLV("00", "A000000727") + buildTLV("01", bankBin) + buildTLV("02", accountNo);

  let payload = "";
  payload += buildTLV("00", "01"); // Payload Format Indicator
  payload += buildTLV("01", "12"); // Point of Initiation Method (dynamic)
  payload += buildTLV("38", merchantAccInfo); // Merchant Account Info (NAPAS)
  payload += buildTLV("53", "704"); // Transaction Currency (VND)
  payload += buildTLV("54", String(amount)); // Transaction Amount
  payload += buildTLV("58", "VN"); // Country Code
  payload += buildTLV("62", buildTLV("08", memo)); // Additional Data — Purpose of Transaction

  // CRC placeholder + compute
  payload += "6304";
  const crc = crc16CCITT(payload);
  payload += crc;

  return payload;
}

/**
 * Build VietQR URL for rendering (img.vietqr.io free service)
 */
export function generateVietQRUrl({ amount, memo }) {
  const bankBin = BANK_BIN();
  const accountNo = BANK_ACCOUNT();
  return `https://img.vietqr.io/image/${bankBin}-${accountNo}-compact2.jpg?amount=${amount}&addInfo=${encodeURIComponent(memo)}`;
}

export function getBankInfo() {
  return {
    bankName: BANK_NAME(),
    bankBin: BANK_BIN(),
    accountNumber: BANK_ACCOUNT(),
    vndPerCredit: VND_PER_CREDIT(),
  };
}

export function verifyWebhookSecret(incomingSecret) {
  const expected = WEBHOOK_SECRET();
  if (!expected || !incomingSecret) return false;
  const a = Buffer.from(String(incomingSecret));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getPaymentTimeoutMs() {
  return PAYMENT_TIMEOUT_MS;
}

/**
 * Create a pending VND bank transfer payment record.
 * Shared by the web API route and the Telegram bot topup flow (DRY).
 * Returns { id, memo, amountVnd, expiresAt, qrUrl, bankInfo }.
 */
export async function createVndPayment({ userId, credits }) {
  const { v4: uuidv4 } = await import("uuid");
  const { getAdapter } = await import("@/lib/db/driver.js");

  const amountVnd = creditsToVnd(credits);
  const memo = generateMemo();
  const id = uuidv4();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PAYMENT_TIMEOUT_MS).toISOString();

  const db = await getAdapter();
  db.run(
    `INSERT INTO payments (id, userId, network, coin, amountExpected, method, status, credits, amountVnd, memo, expiresAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, userId, "vnd", "VND", 0, "vnd_bank", "pending", credits, amountVnd, memo, expiresAt, now, now]
  );

  const bankInfo = getBankInfo();
  const qrUrl = generateVietQRUrl({ amount: amountVnd, memo });

  return { id, memo, amountVnd, credits, expiresAt, qrUrl, bankInfo };
}

// ─── TLV helpers (EMVCo format) ──────────────────────────────────────────────

function buildTLV(id, value) {
  const len = String(value.length).padStart(2, "0");
  return id + len + value;
}

function crc16CCITT(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc <<= 1;
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
