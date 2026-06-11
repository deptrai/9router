import { describe, it, expect } from "vitest";
import { compactKiroPayload, estimatePayloadTokens } from "../../open-sse/utils/autoCompact.js";

function kiroUser(content) {
  return { userInputMessage: { content, modelId: "claude-opus-4.8" } };
}

function kiroAssistant(content) {
  return { assistantResponseMessage: { content } };
}

describe("auto-compact — Kiro payload", () => {
  it("shortens old Kiro history and annotates the current message", () => {
    const history = Array.from({ length: 40 }, (_, i) => (
      i % 2 === 0 ? kiroUser(`old user ${i} ${"x".repeat(1000)}`) : kiroAssistant(`old assistant ${i} ${"y".repeat(1000)}`)
    ));
    const body = {
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: "test",
        currentMessage: kiroUser("please continue"),
        history,
      },
    };

    const beforeTokens = estimatePayloadTokens(body);
    const result = compactKiroPayload(body, {
      limitTokens: 5_000,
      keepHead: 1,
      keepTail: 4,
      minTail: 4,
    });

    expect(result.applied).toBe(true);
    expect(result.tooLarge).toBe(false);
    expect(result.beforeTokens).toBe(beforeTokens);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(result.afterTokens).toBeLessThanOrEqual(5_000);
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(body.conversationState.history.length).toBeLessThan(history.length);
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain("[9router auto-compact]");
  });

  it("reports tooLarge when current payload cannot fit after dropping history", () => {
    const body = {
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: "test",
        currentMessage: kiroUser("z".repeat(20_000)),
        history: [kiroUser("old"), kiroAssistant("older")],
      },
    };

    const result = compactKiroPayload(body, {
      limitTokens: 100,
      keepHead: 0,
      keepTail: 0,
      minTail: 0,
    });

    expect(result.applied).toBe(true);
    expect(result.tooLarge).toBe(true);
    expect(result.afterTokens).toBeGreaterThan(100);
  });
});

