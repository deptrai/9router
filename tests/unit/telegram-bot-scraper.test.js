/**
 * telegram-bot-scraper.test.js — Story 2-38
 * Covers: validate (AC1,AC2), parser (AC4,AC5), normalizeProduct (AC6), sync interval guard (AC7)
 */
import { describe, it, expect } from "vitest";
import { validate, normalizeProduct, parseTelegramCatalog } from "@/lib/store/suppliers/telegramBotScraperAdapter.js";

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

describe("telegram_bot_scraper — validate (AC1, AC2, AC7)", () => {
  it("valid config passes", () => {
    const result = validate({ botUsername: "tainguyenvibebot", command: "/products", vndPerCredit: 1000 });
    expect(result.ok).toBe(true);
  });

  it("missing botUsername fails", () => {
    const result = validate({ command: "/products", vndPerCredit: 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("botUsername");
  });

  it("missing command fails", () => {
    const result = validate({ botUsername: "bot", vndPerCredit: 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("command");
  });

  it("missing vndPerCredit fails", () => {
    const result = validate({ botUsername: "bot", command: "/products" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("vndPerCredit");
  });

  it("syncIntervalSec < 3600 fails (AC7)", () => {
    const result = validate({ botUsername: "bot", command: "/p", vndPerCredit: 1000, syncIntervalSec: 300 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("3600");
  });

  it("syncIntervalSec >= 3600 passes", () => {
    const result = validate({ botUsername: "bot", command: "/p", vndPerCredit: 1000, syncIntervalSec: 7200 });
    expect(result.ok).toBe(true);
  });
});

describe("telegram_bot_scraper — parseTelegramCatalog (AC4, AC5)", () => {
  const products = parseTelegramCatalog(SAMPLE_CATALOG, { botUsername: "tainguyenvibebot", vndPerCredit: 1000 });

  it("extracts 3 products", () => {
    expect(products.length).toBe(3);
  });

  it("product 1: Kiro Power — sold out, 89 credits", () => {
    const p = products[0];
    expect(p.name).toContain("Kiro Power");
    expect(p.priceVnd).toBe(89000);
    expect(p.priceCredits).toBe(89);
    expect(p.isActive).toBe(false);
    expect(p.stock).toBe(0);
  });

  it("product 2: Kiro Trial — preorder, 450 credits", () => {
    const p = products[1];
    expect(p.name).toContain("Kiro Trial");
    expect(p.priceVnd).toBe(450000);
    expect(p.priceCredits).toBe(450);
    expect(p.isActive).toBe(true);
    expect(p.stock).toBeNull();
  });

  it("product 3: NÂNG KIRO — preorder, 489 credits", () => {
    const p = products[2];
    expect(p.name).toContain("NÂNG");
    expect(p.priceVnd).toBe(489000);
    expect(p.priceCredits).toBe(489);
    expect(p.isActive).toBe(true);
    expect(p.stock).toBeNull();
  });

  it("supplierProductId is stable (same input → same id)", () => {
    const products2 = parseTelegramCatalog(SAMPLE_CATALOG, { botUsername: "tainguyenvibebot", vndPerCredit: 1000 });
    expect(products[0].supplierProductId).toBe(products2[0].supplierProductId);
    expect(products[1].supplierProductId).toBe(products2[1].supplierProductId);
  });

  it("all products have deliveryMode=admin_fulfill", () => {
    for (const p of products) {
      expect(p.deliveryMode).toBe("admin_fulfill");
    }
  });

  it("all products have targetType and targetId", () => {
    for (const p of products) {
      expect(p.targetType).toBe("telegram_bot_scraper");
      expect(p.targetId).toBe("tainguyenvibebot");
    }
  });

  it("custom vndPerCredit changes priceCredits", () => {
    const p500 = parseTelegramCatalog(SAMPLE_CATALOG, { botUsername: "x", vndPerCredit: 500 });
    expect(p500[0].priceCredits).toBe(178); // ceil(89000/500)
  });

  it("empty text returns empty array", () => {
    expect(parseTelegramCatalog("", {})).toEqual([]);
  });

  it("text without numbered products returns empty", () => {
    expect(parseTelegramCatalog("Hello world\nno products here", {})).toEqual([]);
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
    expect(result.priceCredits).toBe(0);
    expect(result.isActive).toBe(true);
  });
});
