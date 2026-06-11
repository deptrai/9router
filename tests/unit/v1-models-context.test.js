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

import { buildModelsList } from "@/app/api/v1/models/route.js";
import { GET as getModelInfo } from "@/app/api/v1/models/info/route.js";
import { getCombos, getCustomModels, getModelAliases, getProviderConnections } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";

function mockModelSources({ connections = [], combos = [], customModels = [], aliases = {}, disabled = {} } = {}) {
  getProviderConnections.mockResolvedValue(connections);
  getCombos.mockResolvedValue(combos);
  getCustomModels.mockResolvedValue(customModels);
  getModelAliases.mockResolvedValue(aliases);
  getDisabledModels.mockResolvedValue(disabled);
}

describe("/v1/models context metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModelSources();
  });

  it("publishes context metadata for GPT 5.5 effort variants in the model list", async () => {
    const models = await buildModelsList(["llm"]);

    const gpt55Xhigh = models.find((model) => model.id === "cx/gpt-5.5-xhigh");

    expect(gpt55Xhigh).toMatchObject({
      context_window: 1_050_000,
      contextWindow: 1_050_000,
      max_context_length: 1_050_000,
    });
  });

  it("publishes the effective Kiro input limit for direct Kiro models", async () => {
    const models = await buildModelsList(["llm"]);

    const kiroOpus = models.find((model) => model.id === "kr/claude-opus-4.8-thinking-agentic");
    const kiroSonnet = models.find((model) => model.id === "kr/claude-sonnet-4.6");

    expect(kiroOpus).toMatchObject({
      context_window: 150_000,
      contextWindow: 150_000,
      max_context_length: 150_000,
    });
    expect(kiroSonnet).toMatchObject({
      context_window: 150_000,
      contextWindow: 150_000,
      max_context_length: 150_000,
    });
  });

  it("publishes the minimum known context window for combo models", async () => {
    mockModelSources({
      combos: [
        {
          name: "opus-then-gpt55",
          models: JSON.stringify(["cc/claude-opus-4-8", "cx/gpt-5.5-xhigh"]),
        },
      ],
    });

    const models = await buildModelsList(["llm"]);
    const combo = models.find((model) => model.id === "opus-then-gpt55");

    expect(combo).toMatchObject({
      owned_by: "combo",
      context_window: 1_000_000,
      contextWindow: 1_000_000,
      max_context_length: 1_000_000,
    });
  });

  it("publishes the effective Kiro input limit for combo models", async () => {
    mockModelSources({
      combos: [
        {
          name: "kiro-then-gpt55",
          models: JSON.stringify(["kr/claude-opus-4.8-thinking-agentic", "cx/gpt-5.5-xhigh"]),
        },
      ],
    });

    const models = await buildModelsList(["llm"]);
    const combo = models.find((model) => model.id === "kiro-then-gpt55");

    expect(combo).toMatchObject({
      owned_by: "combo",
      context_window: 150_000,
      contextWindow: 150_000,
      max_context_length: 150_000,
    });
  });

  it("resolves combo context metadata from provider-id model strings", async () => {
    mockModelSources({
      combos: [
        {
          name: "provider-id-combo",
          models: ["claude/claude-opus-4-8", "codex/gpt-5.5-xhigh"],
        },
      ],
    });

    const models = await buildModelsList(["llm"]);
    const combo = models.find((model) => model.id === "provider-id-combo");

    expect(combo.context_window).toBe(1_000_000);
  });

  it("omits combo context metadata when any member window is unknown", async () => {
    mockModelSources({
      combos: [
        {
          name: "unknown-window-combo",
          models: ["cx/gpt-5.5-xhigh", "some-provider/some-model"],
        },
      ],
    });

    const models = await buildModelsList(["llm"]);
    const combo = models.find((model) => model.id === "unknown-window-combo");

    expect(combo).not.toHaveProperty("context_window");
    expect(combo).not.toHaveProperty("contextWindow");
    expect(combo).not.toHaveProperty("max_context_length");
  });

  it("returns context metadata from /v1/models/info", async () => {
    const response = await getModelInfo(new Request("https://router.local/v1/models/info?id=cx/gpt-5.5-xhigh"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: "cx/gpt-5.5-xhigh",
      context_window: 1_050_000,
      contextWindow: 1_050_000,
      max_context_length: 1_050_000,
    });
  });

  it("returns the effective Kiro input limit from /v1/models/info", async () => {
    const response = await getModelInfo(new Request("https://router.local/v1/models/info?id=kr/claude-opus-4.8-thinking-agentic"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: "kr/claude-opus-4.8-thinking-agentic",
      context_window: 150_000,
      contextWindow: 150_000,
      max_context_length: 150_000,
    });
  });
});
