import { describe, it, expect } from "vitest";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";

describe("Windsurf Routing (Story 1.4b)", () => {
  describe("parseModel - alias resolution", () => {
    it("should resolve ws alias to windsurf provider", () => {
      const result = parseModel("ws/sonnet-4.6");
      expect(result.provider).toBe("windsurf");
      expect(result.model).toBe("sonnet-4.6");
      expect(result.providerAlias).toBe("ws");
    });

    it("should resolve windsurf provider ID directly", () => {
      const result = parseModel("windsurf/sonnet-4.6");
      expect(result.provider).toBe("windsurf");
      expect(result.model).toBe("sonnet-4.6");
      expect(result.providerAlias).toBe("windsurf");
    });

    it("should handle all Windsurf model IDs", () => {
      const models = ["sonnet-4.6", "opus-4.8", "glm-5-2"];
      for (const model of models) {
        const result = parseModel(`ws/${model}`);
        expect(result.provider).toBe("windsurf");
        expect(result.model).toBe(model);
      }
    });
  });

  describe("resolveProviderAlias", () => {
    it("should map ws to windsurf", () => {
      expect(resolveProviderAlias("ws")).toBe("windsurf");
    });

    it("should map windsurf to windsurf (identity)", () => {
      expect(resolveProviderAlias("windsurf")).toBe("windsurf");
    });
  });

  describe("getExecutor - executor dispatch", () => {
    it("should return WindsurfExecutor for windsurf provider", () => {
      const executor = getExecutor("windsurf");
      expect(executor.constructor.name).toBe("WindsurfExecutor");
    });

    it("should return WindsurfExecutor for ws alias (via resolveProviderAlias)", () => {
      const provider = resolveProviderAlias("ws");
      const executor = getExecutor(provider);
      expect(executor.constructor.name).toBe("WindsurfExecutor");
    });
  });

  describe("getModelUpstreamId - model mapping", () => {
    it("should map sonnet-4.6 to claude-sonnet-4-6-thinking", () => {
      const upstreamId = getModelUpstreamId("ws", "sonnet-4.6");
      expect(upstreamId).toBe("claude-sonnet-4-6-thinking");
    });

    it("should map opus-4.8 to claude-opus-4-8-medium", () => {
      const upstreamId = getModelUpstreamId("ws", "opus-4.8");
      expect(upstreamId).toBe("claude-opus-4-8-medium");
    });

    it("should map glm-5-2 to glm-5-2", () => {
      const upstreamId = getModelUpstreamId("ws", "glm-5-2");
      expect(upstreamId).toBe("glm-5-2");
    });
  });
});
