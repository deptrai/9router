import { describe, it, expect } from "vitest";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("Windsurf Provider Config", () => {
  it("windsurf trong PROVIDERS", () => {
    expect(PROVIDERS.windsurf).toBeDefined();
    expect(PROVIDERS.windsurf.baseUrl).toBe("https://server.self-serve.windsurf.com");
    expect(PROVIDERS.windsurf.format).toBe("windsurf");
  });

  it("windsurf trong PROVIDER_MODELS", () => {
    expect(PROVIDER_MODELS.windsurf).toBeDefined();
    expect(PROVIDER_MODELS.windsurf.length).toBeGreaterThanOrEqual(1);
    const swe = PROVIDER_MODELS.windsurf.find((m) => m.id === "swe-1-6");
    expect(swe).toBeDefined();
    expect(swe.upstreamModelId).toBe("swe-1-6");
  });

  it("windsurf trong APIKEY_PROVIDERS", () => {
    expect(APIKEY_PROVIDERS.windsurf).toBeDefined();
    expect(APIKEY_PROVIDERS.windsurf.serviceKinds).toContain("llm");
    expect(APIKEY_PROVIDERS.windsurf.hasProviderSpecificData).toBe(false);
  });

  it("hasSpecializedExecutor('windsurf') === true", () => {
    expect(hasSpecializedExecutor("windsurf")).toBe(true);
  });

  it("hasSpecializedExecutor('devin') === true", () => {
    expect(hasSpecializedExecutor("devin")).toBe(true);
  });

  it("getExecutor('windsurf') trả WindsurfExecutor", () => {
    const executor = getExecutor("windsurf");
    expect(executor.constructor.name).toBe("WindsurfExecutor");
  });

  it("getExecutor('devin') trả DevinExecutor", () => {
    const executor = getExecutor("devin");
    expect(executor.constructor.name).toBe("DevinExecutor");
  });
});
