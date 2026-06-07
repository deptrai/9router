// Story 2.8 Task 2: NOWPayments client unit tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";

let getPayCurrencyCode, createInvoice, verifyIpnSignature;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("@/lib/payment/nowpayments.js");
  getPayCurrencyCode = mod.getPayCurrencyCode;
  createInvoice = mod.createInvoice;
  verifyIpnSignature = mod.verifyIpnSignature;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NOWPAYMENTS_API_KEY;
  delete process.env.NOWPAYMENTS_IPN_SECRET;
});

describe("getPayCurrencyCode", () => {
  it("maps all supported coin/network combos", () => {
    expect(getPayCurrencyCode("USDT", "tron")).toBe("usdttrc20");
    expect(getPayCurrencyCode("USDT", "ethereum")).toBe("usdterc20");
    expect(getPayCurrencyCode("USDT", "polygon")).toBe("usdtpolygon");
    expect(getPayCurrencyCode("USDT", "solana")).toBe("usdtsol");
    expect(getPayCurrencyCode("USDC", "ethereum")).toBe("usdcerc20");
    expect(getPayCurrencyCode("USDC", "polygon")).toBe("usdcpolygon");
    expect(getPayCurrencyCode("USDC", "solana")).toBe("usdcsol");
    expect(getPayCurrencyCode("USDC", "tron")).toBe("usdctrc20");
  });

  it("is case-insensitive", () => {
    expect(getPayCurrencyCode("usdt", "TRON")).toBe("usdttrc20");
    expect(getPayCurrencyCode("Usdc", "Polygon")).toBe("usdcpolygon");
  });

  it("throws on unsupported combo", () => {
    expect(() => getPayCurrencyCode("BTC", "tron")).toThrow("Unsupported");
    expect(() => getPayCurrencyCode("USDT", "avalanche")).toThrow("Unsupported");
    expect(() => getPayCurrencyCode(null, null)).toThrow("Unsupported");
  });
});

describe("verifyIpnSignature", () => {
  const secret = "test-secret-123";

  function makeSignature(body) {
    const parsed = JSON.parse(body);
    const sorted = JSON.stringify(
      Object.fromEntries(Object.keys(parsed).sort().map((k) => [k, parsed[k]]))
    );
    return createHmac("sha512", secret).update(sorted).digest("hex");
  }

  it("returns true for valid signature", () => {
    const body = JSON.stringify({ payment_id: 123, payment_status: "finished", price_amount: 10 });
    const sig = makeSignature(body);
    expect(verifyIpnSignature(body, sig, secret)).toBe(true);
  });

  it("returns false for invalid signature", () => {
    const body = JSON.stringify({ payment_id: 123, payment_status: "finished" });
    expect(verifyIpnSignature(body, "badsig", secret)).toBe(false);
  });

  it("returns false for tampered body", () => {
    const original = JSON.stringify({ payment_id: 123, amount: 10 });
    const sig = makeSignature(original);
    const tampered = JSON.stringify({ payment_id: 123, amount: 999 });
    expect(verifyIpnSignature(tampered, sig, secret)).toBe(false);
  });

  it("returns false for missing args", () => {
    expect(verifyIpnSignature("", "sig", secret)).toBe(false);
    expect(verifyIpnSignature("{}", "", secret)).toBe(false);
    expect(verifyIpnSignature("{}", "sig", "")).toBe(false);
    expect(verifyIpnSignature(null, "sig", secret)).toBe(false);
  });

  it("handles key ordering (sorts alphabetically)", () => {
    const body = JSON.stringify({ zebra: 1, alpha: 2, middle: 3 });
    const sig = makeSignature(body);
    // Same data, different key order in source — should still verify
    const reordered = JSON.stringify({ middle: 3, zebra: 1, alpha: 2 });
    expect(verifyIpnSignature(reordered, sig, secret)).toBe(true);
  });
});

describe("createInvoice", () => {
  it("throws when NOWPAYMENTS_API_KEY not set", async () => {
    delete process.env.NOWPAYMENTS_API_KEY;
    await expect(
      createInvoice({ amount: 10, coin: "USDT", network: "tron", orderId: "o1" })
    ).rejects.toThrow("NOWPAYMENTS_API_KEY is not configured");
  });

  it("calls NOWPayments API and returns response (happy path mock)", async () => {
    process.env.NOWPAYMENTS_API_KEY = "test-key";
    const mockResponse = { id: "inv-1", invoice_url: "https://nowpayments.io/payment/?iid=inv-1" };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await createInvoice({
      amount: 10, coin: "USDT", network: "tron", orderId: "order-123", baseUrl: "http://test.local",
    });

    expect(result).toEqual(mockResponse);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.nowpayments.io/v1/invoice");
    expect(opts.headers["x-api-key"]).toBe("test-key");
    const body = JSON.parse(opts.body);
    expect(body.pay_currency).toBe("usdttrc20");
    expect(body.price_amount).toBe(10);
    expect(body.ipn_callback_url).toBe("http://test.local/api/webhooks/crypto");

    delete global.fetch;
  });

  it("throws on NOWPayments non-2xx", async () => {
    process.env.NOWPAYMENTS_API_KEY = "test-key";
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad Request"),
    });

    await expect(
      createInvoice({ amount: 10, coin: "USDT", network: "tron", orderId: "o1", baseUrl: "http://x" })
    ).rejects.toThrow("NOWPayments API error 400");

    delete global.fetch;
  });
});
