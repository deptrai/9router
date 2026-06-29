// Story N.3 — Windsurf upstream usage API stub test (B2)
// Verify case "windsurf" trong getUsageForProvider trả message (không crash).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
});

describe("getUsageForProvider — windsurf case (AC5-7, B2 stub)", () => {
  it("trả message placeholder, không throw", async () => {
    const { getUsageForProvider } = await import("../../open-sse/services/usage.js");

    const result = await getUsageForProvider({
      provider: "windsurf",
      accessToken: "fake-token",
      providerSpecificData: {},
    });

    expect(result).toBeDefined();
    expect(result.message).toContain("Windsurf");
    expect(result.message).toContain("not yet implemented");
  });

  it("không gọi fetch (không network call)", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    proxyAwareFetch.mockClear();

    const { getUsageForProvider } = await import("../../open-sse/services/usage.js");
    await getUsageForProvider({
      provider: "windsurf",
      accessToken: "fake-token",
    });

    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("fail-open giống default case — trả object, không throw", async () => {
    const { getUsageForProvider } = await import("../../open-sse/services/usage.js");

    // Không có accessToken — vẫn không throw
    const result = await getUsageForProvider({
      provider: "windsurf",
      accessToken: null,
    });

    expect(result).toBeDefined();
    expect(result.message).toBeDefined();
  });
});
