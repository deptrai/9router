import { describe, it, expect, beforeEach } from "vitest";

import { getModelContextFit, getRotatedModels, isContextWindowError, resetComboRotation } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });

  it("detects when a fallback model cannot fit the estimated context window", () => {
    const fit = getModelContextFit(
      { messages: [{ role: "user", content: "large" }], max_tokens: 1024 },
      "cx/gpt-5.5",
      () => 1_100_000,
    );

    expect(fit.fits).toBe(false);
    expect(fit.contextWindow).toBe(1_050_000);
  });

  it("uses context metadata for provider-id model strings too", () => {
    const fit = getModelContextFit(
      { messages: [{ role: "user", content: "large" }] },
      "codex/gpt-5.5",
      () => 1_100_000,
    );

    expect(fit.fits).toBe(false);
    expect(fit.contextWindow).toBe(1_050_000);
  });

  it("recognizes provider context-window error messages", () => {
    expect(isContextWindowError("Your input exceeds the context window of this model")).toBe(true);
    expect(isContextWindowError({ code: "context_window_exceeded" })).toBe(true);
    expect(isContextWindowError({ message: "Input is too long.", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" })).toBe(true);
    expect(isContextWindowError("invalid request body")).toBe(false);
  });

  it("does not treat GPT 5.5 xhigh as a larger-context fallback", () => {
    const body = { messages: [{ role: "user", content: "large" }] };
    const estimateInputTokens = () => 1_000_000;

    const xhigh = getModelContextFit(body, "cx/gpt-5.5-xhigh", estimateInputTokens);
    const low = getModelContextFit(body, "cx/gpt-5.5-low", estimateInputTokens);

    expect(xhigh.contextWindow).toBe(1_050_000);
    expect(low.contextWindow).toBe(1_050_000);
    expect(xhigh.fits).toBe(false);
    expect(low.fits).toBe(false);
  });

  it("uses Kiro provider input limit as the effective context for Opus 4.8", () => {
    const fit = getModelContextFit(
      { messages: [{ role: "user", content: "large Kiro session" }] },
      "kr/claude-opus-4.8-thinking-agentic",
      () => 500_000,
    );

    expect(fit.contextWindow).toBe(480_000);
    expect(fit.inputLimit).toBe(480_000);
    expect(fit.effectiveLimit).toBe(480_000);
    expect(fit.fits).toBe(false);
  });

  it("counts requested output tokens against the context window", () => {
    const body = {
      messages: [{ role: "user", content: "large" }],
      max_tokens: 10_000,
    };

    const fit = getModelContextFit(body, "cx/gpt-5.5", () => 950_000);

    expect(fit.contextWindow).toBe(1_050_000);
    expect(fit.requiredTokens - fit.estimatedTokens).toBe(10_000);
    expect(fit.requiredTokens).toBeGreaterThan(fit.contextWindow);
    expect(fit.fits).toBe(false);
  });
});
