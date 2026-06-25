/**
 * Story N.1 — AC1, AC7: Devin provider config đồng bộ 3 registry.
 * Pure assertions — không mock, import trực tiếp các registry.
 */
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/config/providers.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { hasSpecializedExecutor } from "open-sse/executors/index.js";

describe("Story N.1 — Devin provider config (3 registry đồng bộ)", () => {
  it("PROVIDERS.devin tồn tại với format 'devin' và baseUrl v3 organizations", () => {
    expect(PROVIDERS.devin).toBeDefined();
    expect(PROVIDERS.devin.format).toBe("devin");
    expect(PROVIDERS.devin.baseUrl).toBe("https://api.devin.ai/v3/organizations");
    // KHÔNG OAuth fields
    expect(PROVIDERS.devin.clientId).toBeUndefined();
    expect(PROVIDERS.devin.tokenUrl).toBeUndefined();
    expect(PROVIDERS.devin.authUrl).toBeUndefined();
  });

  it("PROVIDER_MODELS.devin có đúng 4 mode: normal/fast/lite/ultra", () => {
    const models = PROVIDER_MODELS.devin;
    expect(models).toBeDefined();
    expect(Array.isArray(models)).toBe(true);
    expect(models).toHaveLength(4);
    const ids = models.map(m => m.id);
    expect(ids).toEqual(["normal", "fast", "lite", "ultra"]);
    for (const m of models) {
      expect(m.name).toMatch(/^Devin /);
    }
  });

  it("PROVIDER_ID_TO_ALIAS.devin === 'devin' (KHÔNG trong OAUTH_ALIASES)", () => {
    expect(PROVIDER_ID_TO_ALIAS.devin).toBe("devin");
  });

  it("AI_PROVIDERS.devin tồn tại với alias 'devin', serviceKinds ['llm'], hasProviderSpecificData true", () => {
    const p = AI_PROVIDERS.devin;
    expect(p).toBeDefined();
    expect(p.id).toBe("devin");
    expect(p.alias).toBe("devin");
    expect(p.name).toBe("Devin");
    expect(p.serviceKinds).toEqual(["llm"]);
    expect(p.hasProviderSpecificData).toBe(true);
    expect(p.website).toBe("https://devin.ai");
    expect(p.notice?.apiKeyUrl).toBe("https://app.devin.ai/settings/service-users");
  });

  it("AC7 — model ID render là devin/<mode> (cross-registry nhất quán)", () => {
    const alias = PROVIDER_ID_TO_ALIAS.devin;
    const models = PROVIDER_MODELS[alias];
    expect(alias).toBe("devin");
    expect(models.map(m => `devin/${m.id}`)).toEqual([
      "devin/normal",
      "devin/fast",
      "devin/lite",
      "devin/ultra",
    ]);
  });

  it("N.2 wire point — hasSpecializedExecutor('devin') === true (N.2 đã register DevinExecutor)", () => {
    expect(hasSpecializedExecutor("devin")).toBe(true);
  });
});
