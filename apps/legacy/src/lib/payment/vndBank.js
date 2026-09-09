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
const PAYMENT_TIMEOUT_MS = () => Number(process.env.VND_PAYMENT_TIMEOUT_MIN || 30) * 60 * 1000;

export function isConfigured() {
  return !!(BANK_ACCOUNT() && BANK_BIN());
}

export function generateMemo() {
  return "9R" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

export function creditsToVnd(credits) {
  if (!Number.isFinite(credits) || !Number.isInteger(credits) || credits < 1) throw new Error("Invalid credits");
  const rate = VND_PER_CREDIT();
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid VND rate");
  const amount = credits * rate;
  if (!Number.isFinite(amount)) throw new Error("Invalid credits");
  return Math.ceil(amount);
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
  const a = crypto.createHash("sha256").update(String(incomingSecret)).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function getPaymentTimeoutMs() {
  return PAYMENT_TIMEOUT_MS();
}

/**
 * Find a pending VND bank transfer payment for the same user+credits that is not expired.
 * Used to avoid duplicate memos when the user taps a preset button multiple times.
 */
export async function getPendingVndPayment(userId, credits) {
  const { listPayments } = await import("@/lib/db/repos/paymentsRepo.js");
  const payments = await listPayments({ userId, status: "pending", limit: 100 });
  const now = Date.now();
  const found = payments.find((p) =>
    p.method === "vnd_bank" &&
    p.credits === credits &&
    p.expiresAt &&
    new Date(p.expiresAt).getTime() > now
  );
  if (!found) return null;
  const amountVnd = creditsToVnd(found.credits);
  const qrUrl = generateVietQRUrl({ amount: amountVnd, memo: found.memo });
  const { vndPerCredit: _, ...bankInfo } = getBankInfo();
  return {
    id: found.id,
    memo: found.memo,
    amountVnd,
    credits: found.credits,
    expiresAt: found.expiresAt,
    qrUrl,
    bankInfo,
  };
}

/**
 * Create a pending VND bank transfer payment record.
 * Shared by the web API route and the Telegram bot topup flow (DRY).
 * Returns { id, memo, amountVnd, expiresAt, qrUrl, bankInfo }.
 */
export async function createVndPayment({ userId, credits, id: requestedId }) {
  const { v4: uuidv4 } = await import("uuid");
  const { getAdapter } = await import("@/lib/db/driver.js");

  const amountVnd = creditsToVnd(credits);
  const memo = generateMemo();
  const id = (typeof requestedId === "string" && requestedId.trim()) ? requestedId.trim() : uuidv4();
  const now = new Date().toISOString();
  const timeoutMs = PAYMENT_TIMEOUT_MS();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid VND payment timeout");
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

  const db = await getAdapter();
  try {
    db.run(
      `INSERT INTO payments (id, userId, network, coin, amountExpected, method, status, credits, amountVnd, memo, expiresAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, userId, "vnd", "VND", 0, "vnd_bank", "pending", credits, amountVnd, memo, expiresAt, now, now]
    );
  } catch (e) {
    const existing = db.get(`SELECT * FROM payments WHERE id = ?`, [id]);
    if (existing) {
      if (existing.userId !== userId) throw new Error("Payment id conflict");
      if (existing.method !== "vnd_bank") throw new Error("Payment id conflict");
      if (Number(existing.credits) !== Number(credits)) throw new Error("VND payment credit mismatch");
      if (existing.status !== "pending") throw new Error("Payment already finalized");
      const expMs = existing.expiresAt ? new Date(existing.expiresAt).getTime() : null;
      if (expMs === null || !Number.isFinite(expMs) || Date.now() > expMs) throw new Error("Payment expired");
      const { vndPerCredit: _, ...clientBankInfo } = getBankInfo();
      return {
        id: existing.id,
        memo: existing.memo,
        amountVnd: existing.amountVnd,
        credits: existing.credits,
        expiresAt: existing.expiresAt,
        qrUrl: generateVietQRUrl({ amount: existing.amountVnd, memo: existing.memo }),
        bankInfo: clientBankInfo,
      };
    }
    throw e;
  }

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
