/**
 * Story N.1 — AC5, AC6: /v1/models trả 4 model devin khi connected hoặc env shortcut.
 * Mock getProviderConnections (localDb) theo pattern v1-models-routes.test.js.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

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
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { getCombos, getCustomModels, getModelAliases, getProviderConnections } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";

function mockModelSources({ connections = [], combos = [], customModels = [], aliases = {}, disabled = {} } = {}) {
  getProviderConnections.mockResolvedValue(connections);
  getCombos.mockResolvedValue(combos);
  getCustomModels.mockResolvedValue(customModels);
  getModelAliases.mockResolvedValue(aliases);
  getDisabledModels.mockResolvedValue(disabled);
}

function devinModelIds(models) {
  return models.filter(m => typeof m.id === "string" && m.id.startsWith("devin/")).map(m => m.id);
}

describe("Story N.1 — /v1/models expose Devin models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModelSources();
    delete process.env.DEVIN_API_KEY;
    delete process.env.DEVIN_ORG_ID;
  });

  afterEach(() => {
    delete process.env.DEVIN_API_KEY;
    delete process.env.DEVIN_ORG_ID;
  });

  it("AC5 — có connection devin active → trả đúng 4 devin/* models", async () => {
    mockModelSources({
      connections: [{ provider: "devin", apiKey: "cog_test", isActive: true, providerSpecificData: { orgId: "org_123" } }],
    });
    const models = await buildModelsList(["llm"]);
    const ids = devinModelIds(models);
    expect(ids).toEqual(["devin/normal", "devin/fast", "devin/lite", "devin/ultra"]);
    for (const item of models.filter(m => m.id?.startsWith("devin/"))) {
      expect(item.object).toBe("model");
      expect(item.owned_by).toBe("devin");
    }
  });

  it("AC6 — không connection + DEVIN_API_KEY + DEVIN_ORG_ID set → vẫn có 4 devin/*", async () => {
    process.env.DEVIN_API_KEY = "cog_env";
    process.env.DEVIN_ORG_ID = "org_env";
    mockModelSources({ connections: [] });
    const models = await buildModelsList(["llm"]);
    expect(devinModelIds(models)).toEqual(["devin/normal", "devin/fast", "devin/lite", "devin/ultra"]);
  });

  it("AC6 — chỉ có DEVIN_API_KEY thiếu DEVIN_ORG_ID (có connection khác) → KHÔNG có devin/*", async () => {
    process.env.DEVIN_API_KEY = "cog_env";
    // DEVIN_ORG_ID không set → không chèn synthetic connection
    mockModelSources({
      connections: [{ provider: "openai", apiKey: "sk_test", isActive: true }],
    });
    const models = await buildModelsList(["llm"]);
    expect(devinModelIds(models)).toEqual([]);
  });

  it("AC5 — có connection khác nhưng KHÔNG có devin + không env → KHÔNG có devin/*", async () => {
    // Dùng 1 connection openai để vào else-branch (không rơi vào static fallback DB-down)
    mockModelSources({
      connections: [{ provider: "openai", apiKey: "sk_test", isActive: true }],
    });
    const models = await buildModelsList(["llm"]);
    expect(devinModelIds(models)).toEqual([]);
  });

  it("AC6 — có cả connection lẫn env → không trùng lặp model (DB ưu tiên)", async () => {
    process.env.DEVIN_API_KEY = "cog_env";
    process.env.DEVIN_ORG_ID = "org_env";
    mockModelSources({
      connections: [{ provider: "devin", apiKey: "cog_db", isActive: true, providerSpecificData: { orgId: "org_db" } }],
    });
    const models = await buildModelsList(["llm"]);
    const ids = devinModelIds(models);
    // Đúng 4, không nhân đôi
    expect(ids).toEqual(["devin/normal", "devin/fast", "devin/lite", "devin/ultra"]);
    expect(ids).toHaveLength(4);
  });
});
