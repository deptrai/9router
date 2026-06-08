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
  it("posts correct body + embeds token in notification_url", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "api-key";
    process.env.BITCART_STORE_ID = "store-abc";
    process.env.BITCART_WEBHOOK_SECRET = "wh-secret";
    process.env.BASE_URL = "http://9r.local";
    global.fetch.mockResolvedValueOnce({
      ok:true, json:async () => ({ id:"inv-xyz", payments:[{ payment_address:"TAddr", payment_url:"http://pay.url", amount:10 }], expiration:"2026-06-08T00:00:00Z" }),
    });
    const { createInvoice } = await import("@/lib/payment/bitcart.js");
    const r = await createInvoice({ amount:10, coin:"USDT", network:"tron", orderId:"ord-1" });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("http://bc.local/invoices");
    const body = JSON.parse(opts.body);
    expect(body.store_id).toBe("store-abc");
    expect(body.notification_url).toContain("token=wh-secret");
    expect(r.gatewayId).toBe("inv-xyz");
    expect(r.payAddress).toBe("TAddr");
  });
  it("API error → throws", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "api-key";
    process.env.BITCART_STORE_ID = "store-abc";
    process.env.BITCART_WEBHOOK_SECRET = "wh-secret";
    global.fetch.mockResolvedValueOnce({ ok:false, status:503, text:async () => "err" });
    const { createInvoice } = await import("@/lib/payment/bitcart.js");
    await expect(createInvoice({ amount:10, coin:"USDT", network:"tron", orderId:"o" })).rejects.toThrow("503");
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
