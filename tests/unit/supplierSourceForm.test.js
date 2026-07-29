import { describe, it, expect } from "vitest";
import {
  ADAPTER_TYPES,
  SYNC_MODES,
  PAYMENT_MODES,
  getDefaultForm,
  getFieldSchema,
  normalizeBotUsername,
  validateSupplierSourceForm,
  buildSupplierSourcePayload,
} from "@/lib/store/suppliers/supplierSourceForm.js";

describe("supplierSourceForm", () => {
  it("exposes expected adapter, sync and payment types", () => {
    expect(ADAPTER_TYPES).toContain("telegram_bot_scraper");
    expect(SYNC_MODES).toEqual(["polling", "webhook"]);
    expect(PAYMENT_MODES).toContain("auto_fulfill");
  });

  it("normalizes bot username by stripping leading @", () => {
    expect(normalizeBotUsername("@tainguyenvibebot")).toBe("tainguyenvibebot");
    expect(normalizeBotUsername("tainguyenvibebot")).toBe("tainguyenvibebot");
  });

  it("validates a complete telegram_bot_scraper form", () => {
    const form = getDefaultForm("telegram_bot_scraper");
    form.name = "Test bot";
    form.auth.botUsername = "tainguyenvibebot";
    form.auth.vndPerCredit = "1000";
    form.auth.relayUrl = "http://127.0.0.1:3800/relay";
    form.auth.relayToken = "secret";
    form.auth.command = "/products";
    form.auth.purchaseCommand = "/buy {{productName}}";
    const result = validateSupplierSourceForm(form);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.errors)).toHaveLength(0);
  });

  it("validates auto_fulfill with purchaseCommand", () => {
    const form = getDefaultForm("telegram_bot_scraper");
    form.name = "Test bot";
    form.paymentMode = "auto_fulfill";
    form.auth.botUsername = "tainguyenvibebot";
    form.auth.vndPerCredit = "1000";
    form.auth.relayUrl = "http://127.0.0.1:3800/relay";
    form.auth.relayToken = "secret";
    form.auth.command = "/products";
    form.auth.purchaseCommand = "/buy";
    const result = validateSupplierSourceForm(form);
    expect(result.ok).toBe(true);
  });

  it("rejects auto_fulfill without purchaseCommand", () => {
    const form = getDefaultForm("telegram_bot_scraper");
    form.name = "Test bot";
    form.paymentMode = "auto_fulfill";
    form.auth.botUsername = "tainguyenvibebot";
    form.auth.vndPerCredit = "1000";
    form.auth.relayUrl = "http://127.0.0.1:3800/relay";
    form.auth.relayToken = "secret";
    form.auth.command = "/products";
    const result = validateSupplierSourceForm(form);
    expect(result.ok).toBe(false);
    expect(result.errors.purchaseCommand).toBeDefined();
  });

  it("rejects invalid bot username, sync interval, and command", () => {
    const form = getDefaultForm("telegram_bot_scraper");
    form.paymentMode = "proxy_checkout";
    form.name = "";
    form.syncIntervalSec = 300;
    form.auth.botUsername = "123";
    form.auth.vndPerCredit = "0";
    form.auth.command = "";
    const result = validateSupplierSourceForm(form);
    expect(result.ok).toBe(false);
    expect(result.errors.name).toBeDefined();
    expect(result.errors.syncIntervalSec).toBeDefined();
    expect(result.errors.botUsername).toBeDefined();
    expect(result.errors.vndPerCredit).toBeDefined();
    expect(result.errors.command).toBeDefined();
  });

  it("validates interactive steps through validateRelayRequest", () => {
    const form = getDefaultForm("telegram_bot_scraper");
    form.name = "Test";
    form.paymentMode = "proxy_checkout";
    form.mode = "interactive";
    form.auth.botUsername = "tainguyenvibebot";
    form.auth.vndPerCredit = "1000";
    form.auth.relayUrl = "http://127.0.0.1:3800/relay";
    form.auth.relayToken = "secret";
    form.auth.interactionSteps = [
      { action: "send", text: "/start" },
      { action: "press", text: "📦 Sản phẩm", match: "contains", collect: true },
    ];
    const result = validateSupplierSourceForm(form);
    expect(result.ok).toBe(true);
  });

  it("rejects short contains target in interactive mode", () => {
    const form = getDefaultForm("telegram_bot_scraper");
    form.name = "Test";
    form.paymentMode = "proxy_checkout";
    form.mode = "interactive";
    form.auth.botUsername = "tainguyenvibebot";
    form.auth.vndPerCredit = "1000";
    form.auth.relayUrl = "http://127.0.0.1:3800/relay";
    form.auth.relayToken = "secret";
    form.auth.interactionSteps = [
      { action: "press", text: "ok", match: "contains" },
    ];
    const result = validateSupplierSourceForm(form);
    expect(result.ok).toBe(false);
    expect(result.errors.interactionSteps).toBeDefined();
  });

  it("builds a create payload with command", () => {
    const form = getDefaultForm("telegram_bot_scraper");
    form.name = "Test";
    form.paymentMode = "proxy_checkout";
    form.auth.botUsername = "@tainguyenvibebot";
    form.auth.vndPerCredit = "1000";
    form.auth.relayUrl = "http://127.0.0.1:3800/relay";
    form.auth.relayToken = "secret";
    form.auth.command = "/products";
    const payload = buildSupplierSourcePayload(form, { isEdit: false });
    expect(payload.name).toBe("Test");
    expect(payload.paymentMode).toBe("proxy_checkout");
    expect(payload.auth.botUsername).toBe("tainguyenvibebot");
    expect(payload.auth.vndPerCredit).toBe(1000);
    expect(payload.auth.command).toBe("/products");
    expect(payload.auth.interactionSteps).toBeUndefined();
    expect(payload.auth.collect).toBeUndefined();
  });

  it("builds an auto_fulfill payload with purchaseCommand", () => {
    const form = getDefaultForm("telegram_bot_scraper");
    form.name = "Test";
    form.paymentMode = "auto_fulfill";
    form.auth.botUsername = "tainguyenvibebot";
    form.auth.vndPerCredit = "1000";
    form.auth.relayUrl = "http://127.0.0.1:3800/relay";
    form.auth.relayToken = "secret";
    form.auth.command = "/products";
    form.auth.purchaseCommand = "/buy";
    const payload = buildSupplierSourcePayload(form, { isEdit: false });
    expect(payload.paymentMode).toBe("auto_fulfill");
    expect(payload.auth.purchaseCommand).toBe("/buy");
    expect(payload.auth.purchaseSteps).toBeUndefined();
  });

  it("builds an edit payload without auth when updateCredentials is false", () => {
    const form = getDefaultForm("telegram_bot_scraper");
    form.name = "Updated";
    form.updateCredentials = false;
    const payload = buildSupplierSourcePayload(form, { isEdit: true });
    expect(payload.name).toBe("Updated");
    expect(payload.auth).toBeUndefined();
  });

  it("builds a clear-auth edit payload", () => {
    const form = getDefaultForm("telegram_bot_scraper");
    form.clearAuth = true;
    const payload = buildSupplierSourcePayload(form, { isEdit: true });
    expect(payload.auth).toBeNull();
  });

  it("validates other adapter types", () => {
    const form = getDefaultForm("supplier_api");
    form.name = "Test API";
    form.auth.apiUrl = "https://api.example.com";
    form.auth.bearerToken = "token";
    const result = validateSupplierSourceForm(form);
    expect(result.ok).toBe(true);
  });

  it("returns schema for each adapter", () => {
    for (const type of ADAPTER_TYPES) {
      expect(getFieldSchema(type)).not.toBeNull();
    }
  });
});
