/**
 * Boundary tests for Windsurf provider — route ↔ core shape alignment.
 *
 * Verifies that the model routing layer used by the route (src/sse/services/model.js)
 * agrees with the model routing layer used by the core (open-sse/services/model.js),
 * and that the alias/registry wiring is internally consistent.
 *
 * These tests catch drift before merge: if one side changes the alias map, the
 * providerModels registry, or the executor registration, the boundary will break.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getModelAliases: vi.fn().mockResolvedValue({}),
  getComboByName: vi.fn().mockResolvedValue(null),
  getProviderNodes: vi.fn().mockResolvedValue([]),
}));

import { getModelInfo } from "@/sse/services/model.js";
import { parseModel, resolveProviderAlias } from "open-sse/services/model.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { getExecutor } from "open-sse/executors/index.js";
import { WindsurfExecutor } from "open-sse/executors/windsurf.js";

describe("Windsurf route ↔ core boundary", () => {
  it("route getModelInfo('ws/sonnet-4.6') matches core parseModel('ws/sonnet-4.6')", async () => {
    const routeInfo = await getModelInfo("ws/sonnet-4.6");
    const coreInfo = parseModel("ws/sonnet-4.6");

    expect(routeInfo.provider).toBe("windsurf");
    expect(routeInfo.model).toBe("sonnet-4.6");
    expect(routeInfo.provider).toBe(coreInfo.provider);
    expect(routeInfo.model).toBe(coreInfo.model);
  });

  it("route getModelInfo('windsurf/sonnet-4.6') also resolves to windsurf/sonnet-4.6", async () => {
    const routeInfo = await getModelInfo("windsurf/sonnet-4.6");
    const coreInfo = parseModel("windsurf/sonnet-4.6");

    expect(routeInfo.provider).toBe("windsurf");
    expect(routeInfo.model).toBe("sonnet-4.6");
    expect(routeInfo.provider).toBe(coreInfo.provider);
    expect(routeInfo.model).toBe(coreInfo.model);
  });

  it("alias wiring is reversible: ws ↔ windsurf", () => {
    expect(resolveProviderAlias("ws")).toBe("windsurf");
    expect(PROVIDER_ID_TO_ALIAS.windsurf).toBe("ws");
  });

  it("PROVIDER_MODELS.ws upstreamModelId matches WindsurfExecutor.getModelUid mapping", () => {
    const executor = new WindsurfExecutor();

    const wsModels = PROVIDER_MODELS.ws;
    expect(wsModels).toHaveLength(3);

    for (const m of wsModels) {
      const expectedUpstream = m.upstreamModelId;
      const actualUpstream = executor.getModelUid(`ws/${m.id}`);
      expect(actualUpstream).toBe(expectedUpstream);
    }
  });

  it("PROVIDERS.windsurf.format is 'claude' and executor dispatch returns WindsurfExecutor", () => {
    expect(PROVIDERS.windsurf).toBeDefined();
    expect(PROVIDERS.windsurf.format).toBe("claude");

    const resolvedProvider = resolveProviderAlias("ws");
    const executor = getExecutor(resolvedProvider);
    expect(executor).toBeInstanceOf(WindsurfExecutor);
  });
});
