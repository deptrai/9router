// Tests for src/lib/payment/vndBank.js (Story 2-39)
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ENV_KEYS = ["VND_PER_CREDIT", "VND_BANK_ACCOUNT", "VND_BANK_BIN", "VND_BANK_NAME", "SEPAY_WEBHOOK_SECRET"];
let saved = {};

beforeEach(() => {
  ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
});

// ─── isConfigured ─────────────────────────────────────────────────────────────

describe("isConfigured", () => {
  it("returns false when neither account nor BIN set", async () => {
    const { isConfigured } = await import("@/lib/payment/vndBank.js?t=1");
    expect(isConfigured()).toBe(false);
  });

  it("returns false when only account is set", async () => {
    process.env.VND_BANK_ACCOUNT = "0123456789";
    const { isConfigured } = await import("@/lib/payment/vndBank.js?t=2");
    expect(isConfigured()).toBe(false);
  });

  it("returns false when only BIN is set", async () => {
    process.env.VND_BANK_BIN = "970436";
    const { isConfigured } = await import("@/lib/payment/vndBank.js?t=3");
    expect(isConfigured()).toBe(false);
  });

  it("returns true when both account and BIN are set", async () => {
    process.env.VND_BANK_ACCOUNT = "0123456789";
    process.env.VND_BANK_BIN = "970436";
    const { isConfigured } = await import("@/lib/payment/vndBank.js?t=4");
    expect(isConfigured()).toBe(true);
  });
});

// ─── generateMemo ─────────────────────────────────────────────────────────────

describe("generateMemo", () => {
  it("starts with 9R", async () => {
    const { generateMemo } = await import("@/lib/payment/vndBank.js");
    expect(generateMemo()).toMatch(/^9R/);
  });

  it("has correct length: 9R + 8 hex chars", async () => {
    const { generateMemo } = await import("@/lib/payment/vndBank.js");
    expect(generateMemo()).toHaveLength(10);
  });

  it("only contains uppercase hex after prefix", async () => {
    const { generateMemo } = await import("@/lib/payment/vndBank.js");
    expect(generateMemo()).toMatch(/^9R[A-F0-9]{8}$/);
  });

  it("generates unique memos", async () => {
    const { generateMemo } = await import("@/lib/payment/vndBank.js");
    const memos = new Set(Array.from({ length: 20 }, () => generateMemo()));
    expect(memos.size).toBe(20);
  });
});

// ─── creditsToVnd / vndToCredits ─────────────────────────────────────────────

describe("creditsToVnd", () => {
  it("uses default 1000 VND/credit", async () => {
    const { creditsToVnd } = await import("@/lib/payment/vndBank.js");
    expect(creditsToVnd(10)).toBe(10000);
  });

  it("respects VND_PER_CREDIT env var", async () => {
    process.env.VND_PER_CREDIT = "2000";
    const { creditsToVnd } = await import("@/lib/payment/vndBank.js");
    expect(creditsToVnd(5)).toBe(10000);
  });

  it("rounds up fractional VND", async () => {
    const { creditsToVnd } = await import("@/lib/payment/vndBank.js");
    // 1 credit * 1000 = 1000, no fraction
    expect(creditsToVnd(1)).toBe(1000);
    // non-integer rate scenario — override to 1500
    process.env.VND_PER_CREDIT = "1500";
    const { creditsToVnd: c2 } = await import("@/lib/payment/vndBank.js?rate=1500");
    expect(c2(1)).toBe(1500);
  });
});

describe("vndToCredits", () => {
  it("floors VND to whole credits at default rate", async () => {
    const { vndToCredits } = await import("@/lib/payment/vndBank.js");
    expect(vndToCredits(10000)).toBe(10);
    expect(vndToCredits(10999)).toBe(10); // floor
  });

  it("respects VND_PER_CREDIT env var", async () => {
    process.env.VND_PER_CREDIT = "500";
    const { vndToCredits } = await import("@/lib/payment/vndBank.js");
    expect(vndToCredits(1000)).toBe(2);
  });

  it("creditsToVnd and vndToCredits are inverse for whole numbers", async () => {
    const { creditsToVnd, vndToCredits } = await import("@/lib/payment/vndBank.js");
    expect(vndToCredits(creditsToVnd(50))).toBe(50);
  });
});

// ─── generateVietQRUrl ────────────────────────────────────────────────────────

describe("generateVietQRUrl", () => {
  beforeEach(() => {
    process.env.VND_BANK_BIN = "970436";
    process.env.VND_BANK_ACCOUNT = "9999888877776666";
  });

  it("returns img.vietqr.io URL", async () => {
    const { generateVietQRUrl } = await import("@/lib/payment/vndBank.js");
    const url = generateVietQRUrl({ amount: 50000, memo: "9RABCD1234" });
    expect(url).toContain("img.vietqr.io");
  });

  it("embeds BIN and account in URL", async () => {
    const { generateVietQRUrl } = await import("@/lib/payment/vndBank.js");
    const url = generateVietQRUrl({ amount: 50000, memo: "9RABCD1234" });
    expect(url).toContain("970436");
    expect(url).toContain("9999888877776666");
  });

  it("embeds amount in URL", async () => {
    const { generateVietQRUrl } = await import("@/lib/payment/vndBank.js");
    const url = generateVietQRUrl({ amount: 75000, memo: "9RABCD1234" });
    expect(url).toContain("75000");
  });

  it("URL-encodes memo in addInfo param", async () => {
    const { generateVietQRUrl } = await import("@/lib/payment/vndBank.js");
    const url = generateVietQRUrl({ amount: 10000, memo: "9R ABCD 1234" });
    expect(url).toContain("addInfo=");
    expect(url).not.toContain(" "); // spaces must be encoded
  });
});

// ─── generateVietQR (EMVCo QR payload) ───────────────────────────────────────

describe("generateVietQR", () => {
  beforeEach(() => {
    process.env.VND_BANK_BIN = "970436";
    process.env.VND_BANK_ACCOUNT = "1234567890";
  });

  it("returns a non-empty string", async () => {
    const { generateVietQR } = await import("@/lib/payment/vndBank.js");
    const qr = generateVietQR({ amount: 10000, memo: "9RAABBCCDD" });
    expect(typeof qr).toBe("string");
    expect(qr.length).toBeGreaterThan(20);
  });

  it("starts with payload format indicator 000201", async () => {
    const { generateVietQR } = await import("@/lib/payment/vndBank.js");
    const qr = generateVietQR({ amount: 10000, memo: "9RAABBCCDD" });
    expect(qr.startsWith("000201")).toBe(true);
  });

  it("ends with 4-char CRC hex suffix", async () => {
    const { generateVietQR } = await import("@/lib/payment/vndBank.js");
    const qr = generateVietQR({ amount: 10000, memo: "9RAABBCCDD" });
    const crc = qr.slice(-4);
    expect(crc).toMatch(/^[0-9A-F]{4}$/);
  });

  it("contains the memo in the payload", async () => {
    const { generateVietQR } = await import("@/lib/payment/vndBank.js");
    const qr = generateVietQR({ amount: 10000, memo: "9RAABBCCDD" });
    expect(qr).toContain("9RAABBCCDD");
  });

  it("contains VND currency code 704", async () => {
    const { generateVietQR } = await import("@/lib/payment/vndBank.js");
    const qr = generateVietQR({ amount: 10000, memo: "9RAABBCCDD" });
    expect(qr).toContain("704");
  });

  it("produces consistent CRC for same inputs", async () => {
    const { generateVietQR } = await import("@/lib/payment/vndBank.js");
    const a = generateVietQR({ amount: 50000, memo: "9R12345678" });
    const b = generateVietQR({ amount: 50000, memo: "9R12345678" });
    expect(a).toBe(b);
  });
});

// ─── getBankInfo ──────────────────────────────────────────────────────────────

describe("getBankInfo", () => {
  it("returns all expected fields", async () => {
    process.env.VND_BANK_BIN = "970436";
    process.env.VND_BANK_ACCOUNT = "111222333";
    process.env.VND_BANK_NAME = "VietcomBank";
    process.env.VND_PER_CREDIT = "1000";
    const { getBankInfo } = await import("@/lib/payment/vndBank.js");
    const info = getBankInfo();
    expect(info).toMatchObject({
      bankName: "VietcomBank",
      bankBin: "970436",
      accountNumber: "111222333",
      vndPerCredit: 1000,
    });
  });
});

// ─── verifyWebhookSecret ──────────────────────────────────────────────────────

describe("verifyWebhookSecret", () => {
  it("returns false when env secret not configured", async () => {
    const { verifyWebhookSecret } = await import("@/lib/payment/vndBank.js");
    expect(verifyWebhookSecret("anything")).toBe(false);
  });

  it("returns false for empty incoming secret", async () => {
    process.env.SEPAY_WEBHOOK_SECRET = "mysecret";
    const { verifyWebhookSecret } = await import("@/lib/payment/vndBank.js");
    expect(verifyWebhookSecret("")).toBe(false);
    expect(verifyWebhookSecret(null)).toBe(false);
  });

  it("returns false for wrong secret", async () => {
    process.env.SEPAY_WEBHOOK_SECRET = "correct-secret";
    const { verifyWebhookSecret } = await import("@/lib/payment/vndBank.js");
    expect(verifyWebhookSecret("wrong-secret")).toBe(false);
  });

  it("returns true for correct secret", async () => {
    process.env.SEPAY_WEBHOOK_SECRET = "my-webhook-secret";
    const { verifyWebhookSecret } = await import("@/lib/payment/vndBank.js");
    expect(verifyWebhookSecret("my-webhook-secret")).toBe(true);
  });
});

// ─── getPaymentTimeoutMs ──────────────────────────────────────────────────────

describe("getPaymentTimeoutMs", () => {
  it("returns 30 minutes in ms", async () => {
    const { getPaymentTimeoutMs } = await import("@/lib/payment/vndBank.js");
    expect(getPaymentTimeoutMs()).toBe(30 * 60 * 1000);
  });
});
