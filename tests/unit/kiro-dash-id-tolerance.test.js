import { describe, it, expect } from "vitest";
import { isValidModel, findModelName, getModelUpstreamId, getModelContextWindow } from "open-sse/config/providerModels.js";
import { resolveKiroModel } from "open-sse/config/kiroConstants.js";

describe("Kiro dash version id tolerance (port of upstream 5041494e)", () => {
  it("treats claude-sonnet-4-5 as claude-sonnet-4.5", () => {
    expect(isValidModel("kr", "claude-sonnet-4-5")).toBe(true);
    expect(findModelName("kr", "claude-sonnet-4-5")).toBe("Claude Sonnet 4.5");
  });

  it("treats claude-opus-4-8 as claude-opus-4.8", () => {
    expect(isValidModel("kr", "claude-opus-4-8")).toBe(true);
    expect(findModelName("kr", "claude-opus-4-8")).toBe("Claude Opus 4.8");
  });

  it("treats claude-haiku-4-5 as claude-haiku-4.5", () => {
    expect(isValidModel("kr", "claude-haiku-4-5")).toBe(true);
    expect(findModelName("kr", "claude-haiku-4-5")).toBe("Claude Haiku 4.5");
  });

  it("preserves exact-match for dot version ids", () => {
    expect(isValidModel("kr", "claude-sonnet-4.5")).toBe(true);
    expect(isValidModel("kr", "claude-opus-4.8")).toBe(true);
  });

  it("returns upstream id for dash variant", () => {
    expect(getModelUpstreamId("kr", "claude-sonnet-4-5")).toBe("claude-sonnet-4.5");
  });

  it("returns context window for dash variant", () => {
    expect(getModelContextWindow("kr", "claude-opus-4-8")).toBe(480_000);
  });

  it("does NOT apply dash normalization to non-Kiro providers", () => {
    // cc uses dash ids natively (claude-opus-4-8) — must stay exact
    expect(isValidModel("cc", "claude-opus-4-8")).toBe(true);
    expect(isValidModel("cc", "claude-opus-4.8")).toBe(false);
  });

  it("rejects unknown Kiro models", () => {
    expect(isValidModel("kr", "claude-opus-9-9")).toBe(false);
  });

  it("resolveKiroModel normalizes dash version separators for upstream", () => {
    expect(resolveKiroModel("claude-sonnet-4-5")).toEqual({
      upstream: "claude-sonnet-4.5",
      agentic: false,
      thinking: false,
    });
    expect(resolveKiroModel("claude-opus-4-8-thinking")).toEqual({
      upstream: "claude-opus-4.8",
      agentic: false,
      thinking: true,
    });
    expect(resolveKiroModel("claude-sonnet-4-5-agentic")).toEqual({
      upstream: "claude-sonnet-4.5",
      agentic: true,
      thinking: false,
    });
  });
});
