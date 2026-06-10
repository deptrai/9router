/**
 * credits-page-source.test.js — Story 2.24, Part D2
 * Source-level checks: credits page fetches correct APIs and renders required sections.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PAGE_PATH = path.resolve("src/app/(dashboard)/dashboard/credits/page.js");
const BALANCE_API_PATH = path.resolve("src/app/api/users/me/balance/route.js");
const CREDIT_SUMMARY_API_PATH = path.resolve("src/app/api/users/me/credit-summary/route.js");

const pageSource = fs.readFileSync(PAGE_PATH, "utf8");
const balanceSource = fs.readFileSync(BALANCE_API_PATH, "utf8");
const summarySource = fs.readFileSync(CREDIT_SUMMARY_API_PATH, "utf8");

describe("credits page source — API fetch calls (AC1-AC5)", () => {
  it("fetches /api/users/me/balance for bucket breakdown", () => {
    expect(pageSource).toContain("/api/users/me/balance");
  });

  it("fetches /api/users/me/credit-summary for spent-by-type", () => {
    expect(pageSource).toContain("/api/users/me/credit-summary");
  });

  it("fetches /api/auth/status for authProviders", () => {
    expect(pageSource).toContain("/api/auth/status");
    expect(pageSource).toContain("authProviders");
  });
});

describe("credits page source — bucket cards (AC1, AC2)", () => {
  it("renders Standard bucket", () => {
    expect(pageSource).toContain('"standard"');
    expect(pageSource).toContain("Standard");
  });

  it("renders Bonus bucket", () => {
    expect(pageSource).toContain('"bonus"');
    expect(pageSource).toContain("Bonus");
  });

  it("renders Resource bucket", () => {
    expect(pageSource).toContain('"resource"');
    expect(pageSource).toContain("Resource");
  });

  it("handles bonusExpiresAt validity date", () => {
    expect(pageSource).toContain("bonusExpiresAt");
    expect(pageSource).toContain("Hết hạn");
  });

  it("handles standardExpiresAt validity date", () => {
    expect(pageSource).toContain("standardExpiresAt");
  });
});

describe("credits page source — deduction priority (AC3)", () => {
  it("shows Resource → Bonus → Standard priority label", () => {
    expect(pageSource).toContain("Resource → Bonus → Standard");
  });
});

describe("credits page source — auth providers section (AC4)", () => {
  it("shows providers list", () => {
    expect(pageSource).toContain("Phương thức đăng nhập");
    expect(pageSource).toContain("Google");
    expect(pageSource).toContain("Telegram");
  });

  it("links to profile page for management", () => {
    expect(pageSource).toContain("/dashboard/profile");
  });
});

describe("credits page source — spent by type (AC5)", () => {
  it("shows Chi tiêu theo loại credit section", () => {
    expect(pageSource).toContain("Chi tiêu theo loại credit");
  });
});

describe("balance API source — bucket query (AC1)", () => {
  it("queries creditTransactions grouped by bucket", () => {
    expect(balanceSource).toContain("creditTransactions");
    expect(balanceSource).toContain("GROUP BY bucket");
  });

  it("filters expired rows", () => {
    expect(balanceSource).toContain("expiresAt");
  });

  it("returns bonusExpiresAt and standardExpiresAt", () => {
    expect(balanceSource).toContain("bonusExpiresAt");
    expect(balanceSource).toContain("standardExpiresAt");
  });
});

describe("credit-summary API source — bucket deduction query", () => {
  it("queries usage_deduction type", () => {
    expect(summarySource).toContain("usage_deduction");
    expect(summarySource).toContain("GROUP BY bucket");
  });

  it("uses ABS for spent amount", () => {
    expect(summarySource).toContain("ABS");
  });

  it("has period filter", () => {
    expect(summarySource).toContain("createdAt >= ?");
  });
});
