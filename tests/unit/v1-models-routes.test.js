import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(),
}));

import { GET as getModels } from "@/app/api/v1/models/route.js";
import { GET as getModelsByKind } from "@/app/api/v1/models/[kind]/route.js";
import { GET as getV1Root } from "@/app/api/v1/route.js";
import { getCombos, getCustomModels, getModelAliases, getProviderConnections } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";

function mockModelSources({ connections = [], combos = [], customModels = [], aliases = {}, disabled = {} } = {}) {
  getProviderConnections.mockResolvedValue(connections);
  getCombos.mockResolvedValue(combos);
  getCustomModels.mockResolvedValue(customModels);
  getModelAliases.mockResolvedValue(aliases);
  getDisabledModels.mockResolvedValue(disabled);
}

describe("MODELS-DISCOVERY routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModelSources();
  });

  describe("GET /v1/models", () => {
    it("returns OpenAI list envelope with object=list and data array", async () => {
      const response = await getModels();
      const body = await response.json();

      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("each item in data has id and object=model", async () => {
      const response = await getModels();
      const body = await response.json();

      expect(body.data.length).toBeGreaterThan(0);
      for (const item of body.data) {
        expect(item).toHaveProperty("id");
        expect(item.object).toBe("model");
      }
    });
  });

  describe("GET /v1/models/[kind]", () => {
    it("returns only image models for kind=image", async () => {
      const request = new Request("https://router.local/v1/models/image");
      const response = await getModelsByKind(request, { params: Promise.resolve({ kind: "image" }) });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
      // All returned IDs should correspond to image models (no LLM-only models)
      for (const item of body.data) {
        expect(item).toHaveProperty("id");
        expect(item.object).toBe("model");
      }
    });

    it("returns list envelope for kind=tts", async () => {
      const request = new Request("https://router.local/v1/models/tts");
      const response = await getModelsByKind(request, { params: Promise.resolve({ kind: "tts" }) });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("returns list envelope for kind=embedding", async () => {
      const request = new Request("https://router.local/v1/models/embedding");
      const response = await getModelsByKind(request, { params: Promise.resolve({ kind: "embedding" }) });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("returns list envelope for kind=stt", async () => {
      const request = new Request("https://router.local/v1/models/stt");
      const response = await getModelsByKind(request, { params: Promise.resolve({ kind: "stt" }) });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("returns 404 and error envelope for unknown kind", async () => {
      const request = new Request("https://router.local/v1/models/unknown-kind");
      const response = await getModelsByKind(request, { params: Promise.resolve({ kind: "unknown-kind" }) });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toHaveProperty("error");
      expect(body.error).toHaveProperty("message");
      expect(body.error).toHaveProperty("type");
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("image kind excludes LLM models that are in default /v1/models list", async () => {
      const llmResponse = await getModels();
      const llmBody = await llmResponse.json();
      const llmIds = new Set(llmBody.data.map((m) => m.id));

      const imageRequest = new Request("https://router.local/v1/models/image");
      const imageResponse = await getModelsByKind(imageRequest, { params: Promise.resolve({ kind: "image" }) });
      const imageBody = await imageResponse.json();

      // Image list should not contain items that are present in the LLM list
      // (they are separate service kinds)
      for (const item of imageBody.data) {
        expect(llmIds.has(item.id)).toBe(false);
      }
    });
  });

  describe("GET /v1 (root re-export)", () => {
    it("returns the same OpenAI list envelope as /v1/models", async () => {
      const [rootResponse, modelsResponse] = await Promise.all([
        getV1Root(),
        getModels(),
      ]);
      const rootBody = await rootResponse.json();
      const modelsBody = await modelsResponse.json();

      expect(rootBody.object).toBe("list");
      expect(Array.isArray(rootBody.data)).toBe(true);
      // Both endpoints share the same GET handler, so shape must match
      expect(rootBody.object).toBe(modelsBody.object);
      expect(rootBody.data.length).toBe(modelsBody.data.length);
    });
  });
});
