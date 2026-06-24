import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/v1beta/models/route.js";

describe("MODELS-DISCOVERY: GET /v1beta/models", () => {
  it("returns Gemini list envelope with models array", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveProperty("models");
    expect(Array.isArray(body.models)).toBe(true);
  });

  it("returns a non-empty models list", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.models.length).toBeGreaterThan(0);
  });

  it("each model has name and supportedGenerationMethods", async () => {
    const response = await GET();
    const body = await response.json();

    for (const model of body.models) {
      expect(model).toHaveProperty("name");
      expect(model).toHaveProperty("supportedGenerationMethods");
      expect(Array.isArray(model.supportedGenerationMethods)).toBe(true);
    }
  });

  it("each model name has format 'models/<provider>/<id>'", async () => {
    const response = await GET();
    const body = await response.json();

    for (const model of body.models) {
      expect(model.name).toMatch(/^models\/.+\/.+$/);
    }
  });

  it("each model supportedGenerationMethods includes generateContent", async () => {
    const response = await GET();
    const body = await response.json();

    for (const model of body.models) {
      expect(model.supportedGenerationMethods).toContain("generateContent");
    }
  });
});
