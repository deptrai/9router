/**
 * Route verify tests for Windsurf provider
 * Tests end-to-end wiring: ws/sonnet-4.6 → WindsurfExecutor → Anthropic SSE response
 */

import { describe, it, expect, vi } from "vitest";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS, OAUTH_ALIASES, PROVIDER_ID_TO_ALIAS } from "../../open-sse/config/providerModels.js";
import { WindsurfExecutor } from "../../open-sse/executors/windsurf.js";

describe("Windsurf route verify", () => {
  it("parseModel('ws/sonnet-4.6') → provider='windsurf'", () => {
    const parsed = parseModel("ws/sonnet-4.6");
    expect(parsed.provider).toBe("windsurf");
    expect(parsed.model).toBe("sonnet-4.6");
    expect(parsed.providerAlias).toBe("ws");
  });

  it("getExecutor('windsurf') → WindsurfExecutor (not DefaultExecutor)", () => {
    const executor = getExecutor("windsurf");
    expect(executor).toBeInstanceOf(WindsurfExecutor);
    expect(executor.constructor.name).toBe("WindsurfExecutor");
  });

  it("PROVIDERS.windsurf.format === 'claude'", () => {
    expect(PROVIDERS.windsurf).toBeDefined();
    expect(PROVIDERS.windsurf.format).toBe("claude");
  });

  it("PROVIDER_MODELS.ws has 3 models (sonnet-4.6, opus-4.8, glm-5-2)", () => {
    const wsModels = PROVIDER_MODELS.ws;
    expect(wsModels).toBeDefined();
    expect(wsModels).toHaveLength(3);
    expect(wsModels.map(m => m.id)).toEqual(["sonnet-4.6", "opus-4.8", "glm-5-2"]);
  });

  it("ALIAS_TO_PROVIDER_ID['ws'] === 'windsurf'", () => {
    expect(resolveProviderAlias("ws")).toBe("windsurf");
  });

  it("PROVIDER_ID_TO_ALIAS['windsurf'] === 'ws'", () => {
    expect(PROVIDER_ID_TO_ALIAS.windsurf).toBe("ws");
  });
});
