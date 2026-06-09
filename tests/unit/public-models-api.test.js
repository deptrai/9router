import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/repos/pricingRepo", () => ({
  getPricing: vi.fn(),
}));

import { GET } from "@/app/api/public/models/route";
import { getPricing } from "@/lib/db/repos/pricingRepo";

const MOCK_PRICING = {
  anthropic: {
    "claude-opus-4-6": { input: 5.0, output: 25.0, cached: 0.5, reasoning: 25.0, cache_creation: 6.25 },
    "claude-sonnet-4-6": { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 },
  },
  openai: {
    "gpt-4o": { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0, cache_creation: 2.5 },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getPricing.mockResolvedValue(MOCK_PRICING);
});

describe("GET /api/public/models", () => {
  it("returns flat model array with required fields", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBe(3); // 2 anthropic + 1 openai

    const fields = ["model", "provider", "input", "output", "cached", "reasoning", "cacheCreation"];
    for (const m of body.models) {
      for (const f of fields) {
        expect(m).toHaveProperty(f);
      }
    }
  });

  it("maps provider correctly for each model", async () => {
    const res = await GET();
    const { models } = await res.json();

    const anthropicModels = models.filter((m) => m.provider === "anthropic");
    const openaiModels = models.filter((m) => m.provider === "openai");

    expect(anthropicModels.length).toBe(2);
    expect(openaiModels.length).toBe(1);
    expect(openaiModels[0].model).toBe("gpt-4o");
  });

  it("maps cache_creation to cacheCreation in response", async () => {
    const res = await GET();
    const { models } = await res.json();
    const opus = models.find((m) => m.model === "claude-opus-4-6");
    expect(opus.cacheCreation).toBe(6.25);
  });

  it("does not require authentication", async () => {
    // Route must not call requireAdmin or getDashboardAuthSession
    const src = await import("fs").then((fs) =>
      fs.promises.readFile(
        new URL("../../src/app/api/public/models/route.js", import.meta.url),
        "utf8"
      )
    );
    expect(src).not.toContain("requireAdmin");
    expect(src).not.toContain("getDashboardAuthSession");
  });

  it("sets Cache-Control public header", async () => {
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toContain("public");
  });

  it("returns 500 on getPricing error", async () => {
    getPricing.mockRejectedValue(new Error("db down"));
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
