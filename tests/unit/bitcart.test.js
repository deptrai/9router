// Story 2.9: Bitcart adapter unit tests
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const saved = {};
const KEYS = ["BITCART_BASE_URL","BITCART_API_KEY","BITCART_STORE_ID","BITCART_WEBHOOK_SECRET","BASE_URL"];

beforeEach(() => {
  KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

describe("getProviderName", () => {
  it("returns 'bitcart'", async () => {
    const { getProviderName } = await import("@/lib/payment/bitcart.js");
    expect(getProviderName()).toBe("bitcart");
  });
});

describe("parseIpn — status mapping", () => {
  it.each([
    ["pending","pending"],["paid","pending"],["unconfirmed","confirming"],
    ["confirmed","confirming"],["complete","settled"],["expired","expired"],
    ["invalid","failed"],["refunded","failed"],
  ])("Bitcart '%s' → internal '%s'", async (s, e) => {
    const { parseIpn } = await import("@/lib/payment/bitcart.js");
    const r = parseIpn(JSON.stringify({ id:"inv-1", status:s }));
    expect(r.internalStatus).toBe(e);
    expect(r.gatewayPaymentId).toBe("inv-1");
  });
  it("unknown status → null", async () => {
    const { parseIpn } = await import("@/lib/payment/bitcart.js");
    expect(parseIpn(JSON.stringify({ id:"i2", status:"weird" })).internalStatus).toBeNull();
  });
});

describe("verifyAuth", () => {
  it("valid token → true", async () => {
    process.env.BITCART_WEBHOOK_SECRET = "my-secret";
    const { verifyAuth } = await import("@/lib/payment/bitcart.js");
    expect(verifyAuth({ url:"http://localhost/api/webhooks/bitcart?token=my-secret" })).toBe(true);
  });
  it("wrong token → false", async () => {
    process.env.BITCART_WEBHOOK_SECRET = "my-secret";
    const { verifyAuth } = await import("@/lib/payment/bitcart.js");
    expect(verifyAuth({ url:"http://localhost/api/webhooks/bitcart?token=wrong" })).toBe(false);
  });
  it("missing token → false", async () => {
    process.env.BITCART_WEBHOOK_SECRET = "my-secret";
    const { verifyAuth } = await import("@/lib/payment/bitcart.js");
    expect(verifyAuth({ url:"http://localhost/api/webhooks/bitcart" })).toBe(false);
  });
  it("no secret → false", async () => {
    const { verifyAuth } = await import("@/lib/payment/bitcart.js");
    expect(verifyAuth({ url:"http://localhost/api/webhooks/bitcart?token=anything" })).toBe(false);
  });
});

describe("createInvoice", () => {
  it("missing config → throws", async () => {
    const { createInvoice } = await import("@/lib/payment/bitcart.js");
    await expect(createInvoice({ amount:10, coin:"USDT", network:"tron", orderId:"o" })).rejects.toThrow("not configured");
  });
  it("fetches wallets, selects matching wallet, posts payment_methods", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "api-key";
    process.env.BITCART_STORE_ID = "store-abc";
    process.env.BITCART_WEBHOOK_SECRET = "wh-secret";
    process.env.BASE_URL = "http://9r.local";
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [
          { id:"w-trx-native", currency:"trx", contract:"" },
          { id:"w-trx-usdt", currency:"trx", contract:"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
        ]}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id:"inv-xyz", payments:[{ payment_address:"TAddr", payment_url:"http://pay.url", amount:10 }], expiration:"2026-06-08T00:00:00Z" }),
      });
    const { createInvoice } = await import("@/lib/payment/bitcart.js");
    const r = await createInvoice({ amount:10, coin:"USDT", network:"tron", orderId:"ord-1" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [walletUrl, walletOpts] = global.fetch.mock.calls[0];
    expect(walletUrl).toBe("http://bc.local/wallets");
    expect(walletOpts.headers.Authorization).toBe("Bearer api-key");

    const [url, opts] = global.fetch.mock.calls[1];
    expect(url).toBe("http://bc.local/invoices");
    const body = JSON.parse(opts.body);
    expect(body.store_id).toBe("store-abc");
    expect(body.notification_url).toContain("token=wh-secret");
    expect(body.payment_methods).toEqual(["w-trx-usdt"]);
    expect(r.gatewayId).toBe("inv-xyz");
    expect(r.payAddress).toBe("TAddr");
  });
  it("selects BNB native wallet for coin=BNB network=bsc", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "api-key";
    process.env.BITCART_STORE_ID = "store-abc";
    process.env.BITCART_WEBHOOK_SECRET = "wh-secret";
    process.env.BASE_URL = "http://9r.local";
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [
          { id:"w-bnb-native", currency:"bnb", contract:"" },
          { id:"w-bnb-usdt", currency:"bnb", contract:"0x55d398326f99059ff775485246999027b3197955" },
        ]}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id:"inv-bnb", payments:[{ payment_address:"0xB", payment_url:"http://pay.url", amount:10 }], expiration:900 }),
      });
    const { createInvoice } = await import("@/lib/payment/bitcart.js");
    const r = await createInvoice({ amount:10, coin:"BNB", network:"bsc", orderId:"ord-2" });
    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.payment_methods).toEqual(["w-bnb-native"]);
    expect(r.gatewayId).toBe("inv-bnb");
  });
  it("API error → throws", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "api-key";
    process.env.BITCART_STORE_ID = "store-abc";
    process.env.BITCART_WEBHOOK_SECRET = "wh-secret";
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: [{ id:"w-trx-usdt", currency:"trx", contract:"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }] }),
    });
    global.fetch.mockResolvedValueOnce({ ok:false, status:503, text:async () => "err" });
    const { createInvoice } = await import("@/lib/payment/bitcart.js");
    await expect(createInvoice({ amount:10, coin:"USDT", network:"tron", orderId:"o" })).rejects.toThrow("503");
  });
});

describe("cancelInvoice", () => {
  it("calls DELETE /invoices/{id} and returns true on success", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "api-key";
    process.env.BITCART_STORE_ID = "store-abc";
    global.fetch.mockResolvedValueOnce({ ok: true, text: async () => "ok" });
    const { cancelInvoice } = await import("@/lib/payment/bitcart.js");
    const r = await cancelInvoice("inv-xyz");
    expect(r).toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(opts.method).toBe("DELETE");
    expect(url).toBe("http://bc.local/invoices/inv-xyz");
  });
  it("throws on non-ok response", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "api-key";
    process.env.BITCART_STORE_ID = "store-abc";
    global.fetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "not found" });
    const { cancelInvoice } = await import("@/lib/payment/bitcart.js");
    await expect(cancelInvoice("inv-missing")).rejects.toThrow("404");
  });
});

describe("resolveSettlement", () => {
  it("parses payment[0] correctly", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "api-key";
    process.env.BITCART_STORE_ID = "store-abc";
    global.fetch.mockResolvedValueOnce({ ok:true, json:async () => ({ id:"inv-1", payments:[{ amount:9.99, lookup_field:"0xtx", confirmations:6 }] }) });
    const { resolveSettlement } = await import("@/lib/payment/bitcart.js");
    const r = await resolveSettlement("inv-1");
    expect(r.amountReceived).toBe(9.99);
    expect(r.txHash).toBe("0xtx");
    expect(r.confirmations).toBe(6);
  });
  it("fetch timeout → throws", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "api-key";
    process.env.BITCART_STORE_ID = "store-abc";
    global.fetch.mockImplementationOnce(() => Promise.reject(Object.assign(new Error("aborted"), { name:"AbortError" })));
    const { resolveSettlement } = await import("@/lib/payment/bitcart.js");
    await expect(resolveSettlement("inv-t")).rejects.toThrow();
  });
});
