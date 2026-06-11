import { describe, it, expect } from "vitest";
import { compactKiroPayload, estimatePayloadTokens } from "../../open-sse/utils/autoCompact.js";

function kiroUser(content, context) {
  return {
    userInputMessage: {
      content,
      modelId: "claude-opus-4.8",
      ...(context && { userInputMessageContext: context }),
    },
  };
}

function kiroAssistant(content, toolUses) {
  return {
    assistantResponseMessage: {
      content,
      ...(toolUses && { toolUses }),
    },
  };
}

function toolUse(id) {
  return { toolUseId: id, name: "read_file", input: { path: "x" } };
}

function toolResult(id, text = "tool output") {
  return { toolUseId: id, status: "success", content: [{ text }] };
}

function messageKinds(history) {
  return history.map((item) => item.userInputMessage ? "user" : "assistant");
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

  it("keeps a contiguous recent suffix instead of stitching unrelated head and tail", () => {
    const history = Array.from({ length: 12 }, (_, i) => (
      i % 2 === 0 ? kiroUser(`old user ${i} ${"x".repeat(1000)}`) : kiroAssistant(`old assistant ${i} ${"y".repeat(1000)}`)
    ));
    const body = {
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: "test",
        currentMessage: kiroUser("continue"),
        history,
      },
    };

    const result = compactKiroPayload(body, {
      limitTokens: 3_000,
      keepHead: 2,
      keepTail: 5,
      minTail: 5,
    });

    expect(result.applied).toBe(true);
    expect(body.conversationState.history[0].userInputMessage.content).toContain("old user 8");
    expect(JSON.stringify(body.conversationState.history)).not.toContain("old user 0");
    expect(messageKinds(body.conversationState.history)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("drops a leading assistant when the retained suffix starts mid-turn", () => {
    const history = [
      kiroUser("u0"),
      kiroAssistant("a1"),
      kiroUser("u2"),
      kiroAssistant("a3"),
      kiroUser("u4"),
      kiroAssistant("a5"),
    ];
    const body = {
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: "test",
        currentMessage: kiroUser("continue"),
        history,
      },
    };

    compactKiroPayload(body, {
      limitTokens: 20,
      keepHead: 0,
      keepTail: 3,
      minTail: 3,
    });

    expect(messageKinds(body.conversationState.history)).toEqual(["user", "assistant"]);
    expect(body.conversationState.history[0].userInputMessage.content).toContain("u4");
  });

  it("removes orphan tool_results from retained history", () => {
    const history = [
      kiroUser("u0"),
      kiroAssistant("a1", [toolUse("old-tool")]),
      kiroUser("u2", { toolResults: [toolResult("old-tool", "orphaned after compaction")] }),
      kiroAssistant("a3"),
      kiroUser("u4"),
      kiroAssistant("a5"),
    ];
    const body = {
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: "test",
        currentMessage: kiroUser("continue"),
        history,
      },
    };

    compactKiroPayload(body, {
      limitTokens: 100,
      keepHead: 0,
      keepTail: 4,
      minTail: 4,
    });

    expect(body.conversationState.history[0].userInputMessage.content).toContain("u2");
    expect(body.conversationState.history[0].userInputMessage.userInputMessageContext).toBeUndefined();
  });

  it("preserves current tool_results when their immediate assistant tool_use is retained", () => {
    const history = [
      kiroUser("old"),
      kiroAssistant("call tool", [toolUse("live-tool")]),
    ];
    const body = {
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: "test",
        currentMessage: kiroUser("", { toolResults: [toolResult("live-tool", "result body")] }),
        history,
      },
    };

    compactKiroPayload(body, {
      limitTokens: 60,
      keepHead: 0,
      keepTail: 2,
      minTail: 2,
    });

    expect(body.conversationState.history[1].assistantResponseMessage.toolUses).toHaveLength(1);
    expect(body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults).toHaveLength(1);
  });

  it("flattens current orphan tool_results when the matching assistant tool_use is absent", () => {
    const body = {
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: "test",
        currentMessage: kiroUser("", { toolResults: [toolResult("missing-tool", "result body")] }),
        history: [kiroUser("old"), kiroAssistant("older")],
      },
    };

    compactKiroPayload(body, {
      limitTokens: 60,
      keepHead: 0,
      keepTail: 2,
      minTail: 2,
    });

    const current = body.conversationState.currentMessage.userInputMessage;
    expect(current.userInputMessageContext).toBeUndefined();
    expect(current.content).toContain("Tool result metadata omitted");
    expect(current.content).toContain("result body");
  });
});
