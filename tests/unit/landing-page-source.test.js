import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const root = resolve(__dirname, "../../src");

function read(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("landing page source contracts", () => {
  it("landing/page.js imports Pricing, FAQ, EndpointHighlights", () => {
    const src = read("app/landing/page.js");
    expect(src).toContain("Pricing");
    expect(src).toContain("FAQ");
    expect(src).toContain("EndpointHighlights");
  });

  it("landing/page.js has Discord CTA", () => {
    const src = read("app/landing/page.js");
    expect(src).toContain("discord");
  });

  it("Navigation.js uses useThemeStore for dark/light toggle", () => {
    const src = read("app/landing/components/Navigation.js");
    expect(src).toContain("toggleTheme");
    expect(src).toContain("themeStore");
  });

  it("Navigation.js has EN/VI locale toggle", () => {
    const src = read("app/landing/components/Navigation.js");
    expect(src).toContain("locale");
    expect(src).toContain("VI");
  });

  it("Navigation.js links to /models page", () => {
    const src = read("app/landing/components/Navigation.js");
    expect(src).toContain("/models");
  });

  it("models/page.js imports getPricing server-side", () => {
    const src = read("app/models/page.js");
    expect(src).toContain("getPricing");
    expect(src).toContain("pricingRepo");
  });

  it("api/public/models/route.js has no auth guard", () => {
    const src = read("app/api/public/models/route.js");
    expect(src).not.toContain("requireAdmin");
    expect(src).not.toContain("getDashboardAuthSession");
  });

  it("api/public/plans/route.js has no auth guard and filters userCount", () => {
    const src = read("app/api/public/plans/route.js");
    expect(src).not.toContain("requireAdmin");
    expect(src).not.toContain("userCount");
  });
});
