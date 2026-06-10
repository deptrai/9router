import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { getPricingForModel } from "../../src/shared/constants/pricing.js";

describe("OpenAI Codex model registry", () => {
  it("lists GPT 5.5 effort variants and their review models", () => {
    const ids = PROVIDER_MODELS.cx.map((model) => model.id);

    expect(ids).toEqual(expect.arrayContaining([
      "gpt-5.5",
      "gpt-5.5-review",
      "gpt-5.5-xhigh",
      "gpt-5.5-xhigh-review",
      "gpt-5.5-high",
      "gpt-5.5-high-review",
      "gpt-5.5-low",
      "gpt-5.5-low-review",
      "gpt-5.5-none",
      "gpt-5.5-none-review",
    ]));
  });

  it("maps GPT 5.5 review variants to their upstream model", () => {
    expect(getModelUpstreamId("cx", "gpt-5.5-high-review")).toBe("gpt-5.5-high");
    expect(getModelUpstreamId("cx", "gpt-5.5-none-review")).toBe("gpt-5.5-none");
  });

  it("prices GPT 5.5 effort variants before the generic GPT fallback", () => {
    expect(getPricingForModel("cx", "gpt-5.5-high").input).toBe(8);
    expect(getPricingForModel("cx", "gpt-5.5-high-review").output).toBe(32);
    expect(getPricingForModel("cx", "gpt-5.5-low").input).toBe(4);
    expect(getPricingForModel("cx", "gpt-5.5-none-review").input).toBe(3);
  });
});
