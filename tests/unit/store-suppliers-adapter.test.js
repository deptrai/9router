/**
 * Story 2.30 — adapter registry + per-adapter validate (T3, AC2).
 * Verifies: registry getAdapter unknown→throw; validate rejects scrape/private-bot
 * as unsupported; required-config errors are hard rejects (not unsupported).
 */
import { describe, it, expect } from "vitest";
import { getAdapter, REGISTRY } from "@/lib/store/suppliers/index.js";

describe("adapter registry", () => {
  it("maps all 5 adapter types", () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(
      ["channel_feed", "polling_feed", "supplier_api", "telegram_bot_scraper", "webhook"].sort()
    );
  });

  it("getAdapter(unknown) throws", () => {
    expect(() => getAdapter("scraper_9000")).toThrow(/Unknown adapter type/);
  });

  it("each adapter exposes validate + normalizeProduct + fetchCatalog", () => {
    for (const type of Object.keys(REGISTRY)) {
      const a = getAdapter(type);
      expect(typeof a.validate).toBe("function");
      expect(typeof a.normalizeProduct).toBe("function");
      expect(typeof a.fetchCatalog).toBe("function");
    }
  });
});

describe("supplier_api adapter validate (AC1/AC2)", () => {
  const a = getAdapter("supplier_api");

  it("rejects scrape config as unsupported (AC2)", () => {
    const r = a.validate({ scrape: true, apiUrl: "https://x" });
    expect(r.ok).toBe(false);
    expect(r.unsupported).toBe(true);
    expect(r.reason).toMatch(/out-of-scope MVP|Scraping/i);
  });

  it("hard-rejects missing apiUrl (not unsupported)", () => {
    const r = a.validate({ apiKey: "k" });
    expect(r.ok).toBe(false);
    expect(r.unsupported).toBeUndefined();
    expect(r.reason).toMatch(/apiUrl/);
  });

  it("hard-rejects missing credential", () => {
    const r = a.validate({ apiUrl: "https://x" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/apiKey|bearerToken/);
  });

  it("accepts valid config", () => {
    expect(a.validate({ apiUrl: "https://x", apiKey: "k" })).toEqual({ ok: true });
  });

  it("normalizeProduct maps id/price/stock", () => {
    const n = a.normalizeProduct({ id: 7, title: "Foo", price: 12, stock: 3 });
    expect(n.supplierProductId).toBe("7");
    expect(n.name).toBe("Foo");
    expect(n.priceCredits).toBe(12);
    expect(n.stock).toBe(3);
  });
});

describe("channel_feed adapter validate (AC2)", () => {
  const a = getAdapter("channel_feed");

  it("rejects private bot scraping as unsupported", () => {
    const r = a.validate({ privateBot: true });
    expect(r.ok).toBe(false);
    expect(r.unsupported).toBe(true);
  });

  it("requires feedUrl", () => {
    const r = a.validate({});
    expect(r.ok).toBe(false);
    expect(r.unsupported).toBeUndefined();
    expect(r.reason).toMatch(/feedUrl/);
  });

  it("accepts public feed url", () => {
    expect(a.validate({ feedUrl: "https://t.me/s/foo" }).ok).toBe(true);
  });
});

describe("webhook adapter (push-only)", () => {
  const a = getAdapter("webhook");

  it("requires webhookSecret", () => {
    expect(a.validate({}).ok).toBe(false);
    expect(a.validate({ webhookSecret: "s" }).ok).toBe(true);
  });

  it("fetchCatalog is a no-op error (push-only)", async () => {
    const r = await a.fetchCatalog({}, {});
    expect(r.products).toEqual([]);
    expect(r.error).toMatch(/push-only/);
  });
});

describe("polling_feed adapter validate", () => {
  const a = getAdapter("polling_feed");
  it("requires feedUrl, rejects scrape", () => {
    expect(a.validate({}).ok).toBe(false);
    expect(a.validate({ scrape: true }).unsupported).toBe(true);
    expect(a.validate({ feedUrl: "https://x/feed" }).ok).toBe(true);
  });
});
