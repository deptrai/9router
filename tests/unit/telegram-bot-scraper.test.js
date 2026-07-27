/**
 * telegram-bot-scraper.test.js — Story 2-38
 * Covers: validate (AC1,AC2), parser (AC4,AC5), normalizeProduct (AC6), sync interval guard (AC7)
 * Course correction (2026-07-27): interactive steps validate + relay forwarding (AC2,AC3,AC10,AC11)
 * Code review 2026-07-28: fail-closed config (QĐ5), relay auth token (D1), parser block/price/status
 * guards, reorder-stable supplierProductId (D3).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { validate, normalizeProduct, parseTelegramCatalog, fetchCatalog } from "@/lib/store/suppliers/telegramBotScraperAdapter.js";

const RELAY = { relayUrl: "http://127.0.0.1:3800/relay", relayToken: "test-relay-token" };
const VALID_CONFIG = { botUsername: "tainguyenvibebot", command: "/products", vndPerCredit: 1000, ...RELAY };
const RATE = { botUsername: "tainguyenvibebot", vndPerCredit: 1000 };

const SAMPLE_CATALOG = `🛍️ TÀI NGUYÊN VIBE
━━━━━━━━━━━━━━━━━━━━

1. 📦 Kiro Power 10K Credit 200$ KBH Login URL|USER|PASS
💵 Giá: 89.000đ
📦 ⛔ Hết hàng
🎁 -----
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
2. 📦 Kiro Trial 20$ Chính Hãng Kiro - login Gmail
- Đăng nhập bằng gmail - Có thể bật overages 11k - Hạn dùng có thể đến ngày cuối cùng của tháng.
💵 Giá: 450.000đ
📦 🟡 Đặt trước — giao sau ít phút
🎁 Liên hệ admin
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
3. 📦 NÂNG - KIRO TRIAL CHÍNH CHỦ
Nâng chính chủ tài khoản của bạn - Hoàn thành 4-6h - Dùng đúng Kiro ide hoặc cli thì khả năng die rất thấp. Hạn dùng đến cuối tháng.
💵 Giá: 489.000đ
📦 🟡 Đặt trước — giao sau ít phút
🎁 🔥 Giá sốc`;

/** Parse inside a test body, never at describe-collection time. */
function parseSample(overrides = {}) {
  return parseTelegramCatalog(SAMPLE_CATALOG, { ...RATE, ...overrides });
}

describe("telegram_bot_scraper — validate (AC1, AC2, AC7)", () => {
  beforeEach(() => {
    // Never let ambient env satisfy a requirement the test means to exercise.
    vi.stubEnv("TELEGRAM_SCRAPER_RELAY_URL", "");
    vi.stubEnv("TELEGRAM_SCRAPER_RELAY_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("valid config passes", () => {
    expect(validate(VALID_CONFIG)).toEqual({ ok: true });
  });

  it("missing botUsername fails", () => {
    const result = validate({ ...VALID_CONFIG, botUsername: undefined });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("botUsername");
  });

  it("missing command fails", () => {
    const result = validate({ ...VALID_CONFIG, command: undefined });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("command");
  });

  it("missing vndPerCredit fails", () => {
    const result = validate({ ...VALID_CONFIG, vndPerCredit: undefined });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("vndPerCredit");
  });

  it("non-numeric vndPerCredit fails (QĐ5 fail-closed)", () => {
    const result = validate({ ...VALID_CONFIG, vndPerCredit: "một nghìn" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("vndPerCredit");
  });

  it("missing relayUrl fails instead of creating a source whose every sync errors", () => {
    const result = validate({ ...VALID_CONFIG, relayUrl: undefined });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/relayUrl is required/i);
  });

  it("missing relayToken fails — the relay rejects unauthenticated requests (D1)", () => {
    const result = validate({ ...VALID_CONFIG, relayToken: undefined });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/relayToken is required/i);
  });

  it("relayUrl/relayToken may come from env instead of auth", () => {
    vi.stubEnv("TELEGRAM_SCRAPER_RELAY_URL", "http://127.0.0.1:3800/relay");
    vi.stubEnv("TELEGRAM_SCRAPER_RELAY_TOKEN", "env-token");

    expect(validate({ botUsername: "tainguyenvibebot", command: "/products", vndPerCredit: 1000 }))
      .toEqual({ ok: true });
  });

  it("syncIntervalSec < 3600 fails (AC7)", () => {
    const result = validate({ ...VALID_CONFIG, syncIntervalSec: 300 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("3600");
  });

  it("syncIntervalSec >= 3600 passes", () => {
    expect(validate({ ...VALID_CONFIG, syncIntervalSec: 7200 })).toEqual({ ok: true });
  });

  it("accepts interactionSteps in place of command (AC3, AC11)", () => {
    const result = validate({
      ...RELAY,
      botUsername: "tainguyenvibebot",
      vndPerCredit: 1000,
      interactionSteps: [
        { action: "send", text: "/start" },
        { action: "press", text: "📦 Sản phẩm", match: "contains", collect: true },
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails when both command and interactionSteps are missing (AC2)", () => {
    const result = validate({ ...RELAY, botUsername: "tainguyenvibebot", vndPerCredit: 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/command or interactionSteps/i);
  });

  it("rejects malformed interactionSteps (AC2)", () => {
    const result = validate({
      ...RELAY,
      botUsername: "tainguyenvibebot",
      vndPerCredit: 1000,
      interactionSteps: [{ action: "eval", text: "x" }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/action must be send or press/i);
  });

  it("rejects interactionSteps exceeding the step limit (AC2)", () => {
    const result = validate({
      ...RELAY,
      botUsername: "tainguyenvibebot",
      vndPerCredit: 1000,
      interactionSteps: Array.from({ length: 11 }, () => ({ action: "send", text: "x" })),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/between 1 and 10/i);
  });

  it("rejects an invalid collect bound on interactionSteps (AC2)", () => {
    const result = validate({
      ...RELAY,
      botUsername: "tainguyenvibebot",
      vndPerCredit: 1000,
      interactionSteps: [{ action: "send", text: "/start" }],
      collect: { timeoutMs: 90 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timeoutMs/i);
  });

  it("rejects a short contains target that could press an unintended button (D5)", () => {
    const result = validate({
      ...RELAY,
      botUsername: "tainguyenvibebot",
      vndPerCredit: 1000,
      interactionSteps: [{ action: "press", text: "mua", match: "contains" }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/must be exact when text is shorter/i);
  });
});

describe("telegram_bot_scraper — fetchCatalog relay forwarding (AC3, AC8, AC11)", () => {
  let fetchMock;

  /** Relay responses go through res.text(), so mocks must expose text(). */
  function relayResponse(payload, { ok = true, status = 200 } = {}) {
    return { ok, status, text: async () => JSON.stringify(payload) };
  }

  beforeEach(() => {
    vi.stubEnv("TELEGRAM_SCRAPER_RELAY_URL", "");
    vi.stubEnv("TELEGRAM_SCRAPER_RELAY_TOKEN", "");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards the legacy { botUsername, command } body unchanged (AC11)", async () => {
    fetchMock.mockResolvedValue(relayResponse({ ok: true, messages: ["1. 📦 A\n💵 Giá: 10.000đ"] }));

    await fetchCatalog({}, { ...RELAY, botUsername: "supplier_bot", command: "/products", vndPerCredit: 1000 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ botUsername: "supplier_bot", command: "/products" });
  });

  it("sends the relay auth token as a bearer header (D1)", async () => {
    fetchMock.mockResolvedValue(relayResponse({ ok: true, messages: ["1. 📦 A\n💵 Giá: 10.000đ"] }));

    await fetchCatalog({}, { ...RELAY, botUsername: "supplier_bot", command: "/products", vndPerCredit: 1000 });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer test-relay-token");
  });

  it("forwards interactionSteps as { steps, collect } to the relay (AC3, AC10)", async () => {
    fetchMock.mockResolvedValue(relayResponse({ ok: true, messages: ["1. 📦 A\n💵 Giá: 10.000đ"] }));
    const interactionSteps = [
      { action: "send", text: "/start" },
      { action: "press", text: "📦 Sản phẩm", match: "contains", collect: true },
    ];

    await fetchCatalog({}, {
      ...RELAY,
      botUsername: "tainguyenvibebot",
      interactionSteps,
      collect: { timeoutMs: 5000, idleMs: 500, maxMessages: 10 },
      vndPerCredit: 1000,
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.botUsername).toBe("tainguyenvibebot");
    expect(body.steps).toEqual(interactionSteps);
    expect(body.collect).toEqual({ timeoutMs: 5000, idleMs: 500, maxMessages: 10 });
    expect(body.command).toBeUndefined();
  });

  it("fails soft with the relay error when the bot flow fails (AC8/AC10)", async () => {
    fetchMock.mockResolvedValue(relayResponse({
      ok: false,
      error: 'Step 2 (press) failed: missing button "📦 Sản phẩm"',
    }));

    const result = await fetchCatalog({}, {
      ...RELAY,
      botUsername: "tainguyenvibebot",
      interactionSteps: [{ action: "press", text: "📦 Sản phẩm" }],
      vndPerCredit: 1000,
    });

    expect(result.products).toEqual([]);
    expect(result.error).toMatch(/missing button/i);
  });

  it("fails soft on a non-JSON relay response instead of throwing", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "<html>502</html>" });

    const result = await fetchCatalog({}, { ...RELAY, botUsername: "supplier_bot", command: "/products", vndPerCredit: 1000 });

    expect(result.products).toEqual([]);
    expect(result.error).toMatch(/non-JSON/i);
  });

  it("refuses to price a catalog without vndPerCredit — no hardcoded fallback (QĐ5)", async () => {
    const result = await fetchCatalog({}, { ...RELAY, botUsername: "supplier_bot", command: "/products" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.products).toEqual([]);
    expect(result.error).toMatch(/vndPerCredit/i);
  });

  it("refuses to send a default command when neither command nor interactionSteps is set", async () => {
    const result = await fetchCatalog({}, { ...RELAY, botUsername: "supplier_bot", vndPerCredit: 1000 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.products).toEqual([]);
    expect(result.error).toMatch(/command or interactionSteps missing/i);
  });

  it("refuses to call the relay without a token", async () => {
    const result = await fetchCatalog({}, {
      relayUrl: RELAY.relayUrl, botUsername: "supplier_bot", command: "/products", vndPerCredit: 1000,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error).toMatch(/relayToken not configured/i);
  });

  it("sizes the HTTP timeout above the relay's whole-flow budget, not just collect.timeoutMs", async () => {
    // A 35s fixed timeout used to abort before the relay's own timeout fired, hiding the
    // real relay error behind a generic AbortError (AC8 regression, real E2E 2026-07-28).
    let observedSignal = null;
    fetchMock.mockImplementation(async (_url, options) => {
      observedSignal = options.signal;
      return relayResponse({ ok: true, messages: ["1. 📦 A\n💵 Giá: 10.000đ"] });
    });

    await fetchCatalog({}, {
      ...RELAY,
      botUsername: "tainguyenvibebot",
      interactionSteps: [
        { action: "send", text: "/start" },
        { action: "press", text: "📦 Sản phẩm", match: "contains", collect: true },
      ],
      collect: { timeoutMs: 60_000, idleMs: 1_000, maxMessages: 20 },
      vndPerCredit: 1000,
    });

    // Signal was live (not already aborted) and the request completed.
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(false);
  });
});

describe("telegram_bot_scraper — parseTelegramCatalog (AC4, AC5)", () => {
  it("extracts 3 products", () => {
    expect(parseSample()).toHaveLength(3);
  });

  it("product 1: Kiro Power — sold out, 89 credits", () => {
    const p = parseSample()[0];
    expect(p.name).toContain("Kiro Power");
    expect(p.priceVnd).toBe(89000);
    expect(p.priceCredits).toBe(89);
    expect(p.isActive).toBe(false);
    expect(p.stock).toBe(0);
  });

  it("product 2: Kiro Trial — preorder, 450 credits", () => {
    const p = parseSample()[1];
    expect(p.name).toContain("Kiro Trial");
    expect(p.priceVnd).toBe(450000);
    expect(p.priceCredits).toBe(450);
    expect(p.isActive).toBe(true);
    expect(p.stock).toBeNull();
  });

  it("product 3: NÂNG KIRO — preorder, 489 credits", () => {
    const p = parseSample()[2];
    expect(p.name).toContain("NÂNG");
    expect(p.priceVnd).toBe(489000);
    expect(p.priceCredits).toBe(489);
    expect(p.isActive).toBe(true);
    expect(p.stock).toBeNull();
  });

  it("all products have deliveryMode=admin_fulfill", () => {
    for (const p of parseSample()) {
      expect(p.deliveryMode).toBe("admin_fulfill");
    }
  });

  it("all products carry targetType and targetId on the adapter contract", () => {
    // NOTE (AC6, amended 2026-07-28): catalogSync intentionally does not persist these for
    // external products — they route internal fulfilment and land in the auto-checkout story.
    for (const p of parseSample()) {
      expect(p.targetType).toBe("telegram_bot_scraper");
      expect(p.targetId).toBe("tainguyenvibebot");
    }
  });

  it("custom vndPerCredit changes priceCredits", () => {
    expect(parseSample({ vndPerCredit: 500 })[0].priceCredits).toBe(178); // ceil(89000/500)
  });

  it("throws when vndPerCredit is missing — never prices at a default rate (QĐ5)", () => {
    expect(() => parseTelegramCatalog(SAMPLE_CATALOG, { botUsername: "x" }))
      .toThrow(/vndPerCredit is required/i);
    expect(() => parseTelegramCatalog(SAMPLE_CATALOG, { botUsername: "x", vndPerCredit: 0 }))
      .toThrow(/vndPerCredit is required/i);
  });

  it("empty text returns empty array", () => {
    expect(parseTelegramCatalog("", RATE)).toEqual([]);
  });

  it("text without numbered products returns empty", () => {
    expect(parseTelegramCatalog("Hello world\nno products here", RATE)).toEqual([]);
  });
});

describe("telegram_bot_scraper — supplierProductId stability (AC4, D3)", () => {
  const CATALOG_V1 = "1. 📦 Alpha\n💵 Giá: 10.000đ\n2. 📦 Beta\n💵 Giá: 20.000đ";
  // Supplier inserted a new product at position 1, pushing Alpha and Beta down.
  const CATALOG_V2 = "1. 📦 Gamma\n💵 Giá: 30.000đ\n2. 📦 Alpha\n💵 Giá: 10.000đ\n3. 📦 Beta\n💵 Giá: 20.000đ";

  it("same input produces the same ids", () => {
    const a = parseTelegramCatalog(CATALOG_V1, RATE);
    const b = parseTelegramCatalog(CATALOG_V1, RATE);
    expect(a.map((p) => p.supplierProductId)).toEqual(b.map((p) => p.supplierProductId));
  });

  it("ids survive a catalog REORDER — the displayed number is not part of the hash", () => {
    // The previous hash included the listing position, so inserting one product re-keyed
    // everything below it: catalogSync then orphaned already-published products and lost
    // their order mapping. This is the case the old "stable" test could not see.
    const v1 = parseTelegramCatalog(CATALOG_V1, RATE);
    const v2 = parseTelegramCatalog(CATALOG_V2, RATE);
    const idOf = (products, name) => products.find((p) => p.name === name).supplierProductId;

    expect(idOf(v2, "Alpha")).toBe(idOf(v1, "Alpha"));
    expect(idOf(v2, "Beta")).toBe(idOf(v1, "Beta"));
    expect(idOf(v2, "Gamma")).not.toBe(idOf(v1, "Alpha"));
  });

  it("different bots never collide on the same product name", () => {
    const a = parseTelegramCatalog(CATALOG_V1, { botUsername: "bot_one", vndPerCredit: 1000 });
    const b = parseTelegramCatalog(CATALOG_V1, { botUsername: "bot_two", vndPerCredit: 1000 });
    expect(a[0].supplierProductId).not.toBe(b[0].supplierProductId);
  });
});

describe("telegram_bot_scraper — parser guards (code review 2026-07-28)", () => {
  it("keeps a product whose description contains an ordered list", () => {
    // Splitting on every numbered line cut this block apart, the price landed in the
    // trailing fragment, and the product vanished from the catalog without any error.
    const catalog = `1. 📦 Kiro Trial
Hướng dẫn:
1. Đăng nhập gmail
2. Mở app
💵 Giá: 450.000đ
📦 🟡 Đặt trước`;

    const products = parseTelegramCatalog(catalog, RATE);

    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("Kiro Trial");
    expect(products[0].priceVnd).toBe(450000);
    expect(products[0].description).toContain("Đăng nhập gmail");
  });

  it("does not flip a product to sold-out because its DESCRIPTION mentions Hết hàng", () => {
    const catalog = `1. 📦 Kiro Trial
Nếu Hết hàng thì Liên hệ admin
💵 Giá: 450.000đ
📦 ✅ Còn hàng`;

    const products = parseTelegramCatalog(catalog, RATE);

    expect(products).toHaveLength(1);
    expect(products[0].isActive).toBe(true);
    expect(products[0].stock).toBeNull();
  });

  it("still reads a sold-out marker from the price line itself", () => {
    const products = parseTelegramCatalog("1. 👑 A\n💵 39.000đ · ⛔ Hết hàng", RATE);

    expect(products[0].isActive).toBe(false);
    expect(products[0].stock).toBe(0);
  });

  it("drops a block whose price parses to 0 instead of minting a free product", () => {
    // `([\d.,]+)` also matches a run of separators, which collapses to "" and Number("") is 0.
    expect(parseTelegramCatalog("1. 📦 Broken\n💵 Giá: ..đ", RATE)).toEqual([]);
    expect(parseTelegramCatalog("1. 📦 Broken\n💵 Giá: 0đ", RATE)).toEqual([]);
  });
});

describe("telegram_bot_scraper — parseTelegramCatalog real-world format (E2E 2026-07-28, AC4)", () => {
  // Observed live from @tainguyenvibebot's "TÀI KHOẢN KIRO" category (course correction):
  // product marker emoji is 👑, not the originally-assumed fixed 📦, and price/status
  // share one line separated by "·" instead of separate "💵 Giá:" + "📦 status" lines.
  const REAL_CATALOG = `🛍️ ⚡ TÀI KHOẢN KIRO
📦 1 sản phẩm trong nhóm

1. 👑 TÀI KHOẢN KIRO PROMAX KBH
　　· TÀI KHOẢN KHÔNG BẢO HÀNH. CHO DÙ BẠN MUA XONG DIE LUÔN CŨNG KHÔNG HOÀN TIỀN.
💵 39.000đ · ⛔ Hết hàng

👇 Bấm số bên dưới để mua`;

  it("extracts the product despite a non-📦 marker emoji and inline price/status", () => {
    const products = parseTelegramCatalog(REAL_CATALOG, RATE);
    expect(products).toHaveLength(1);
    expect(products[0].name).toContain("TÀI KHOẢN KIRO PROMAX KBH");
    expect(products[0].priceVnd).toBe(39000);
    expect(products[0].priceCredits).toBe(39);
    expect(products[0].isActive).toBe(false);
    expect(products[0].stock).toBe(0);
  });

  it("does not mis-parse an unrelated leading number without a price as a product", () => {
    expect(parseTelegramCatalog("📦 1 sản phẩm trong nhóm\n\nSome text", RATE)).toEqual([]);
  });
});

describe("telegram_bot_scraper — normalizeProduct (AC6)", () => {
  it("maps fields correctly", () => {
    const raw = { supplierProductId: "abc123", name: "Test", priceCredits: 50, stock: null, description: "desc", isActive: true };
    const result = normalizeProduct(raw);
    expect(result.supplierProductId).toBe("abc123");
    expect(result.name).toBe("Test");
    expect(result.priceCredits).toBe(50);
    expect(result.stock).toBeNull();
    expect(result.description).toBe("desc");
    expect(result.isActive).toBe(true);
  });

  it("defaults for missing fields", () => {
    const result = normalizeProduct({});
    expect(result.supplierProductId).toBe("");
    expect(result.name).toBe("Unnamed");
    // 0 is only reachable when a caller hands normalizeProduct a raw object with no price —
    // parseTelegramCatalog can no longer emit one (a non-positive price drops the block).
    expect(result.priceCredits).toBe(0);
    expect(result.isActive).toBe(true);
  });
});
