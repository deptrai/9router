/**
 * Fix #3 — Kiro request-path sanitize for truncated prior turns.
 *
 * When a kiro stream is cut off mid tool-call, the client persists a malformed
 * assistant turn (tool_use with partial/invalid JSON arguments, or a stray extra
 * assistant turn). The NEXT "continue" request replays that broken history into
 * buildKiroPayload(). Before this fix:
 *   - JSON.parse(partial args) threw → the ENTIRE request translation crashed →
 *     every "continue" kept failing until the conversation was compacted/restarted.
 *   - two consecutive assistant turns survived into kiro history → kiro rejects
 *     non-alternating history.
 *
 * These tests lock the defensive behaviour: malformed history must still convert
 * into a valid, alternating kiro payload instead of throwing.
 */
import { describe, it, expect } from "vitest";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.js";

const MODEL = "claude-sonnet-4.6";

describe("Kiro request sanitize (Fix #3 — truncated prior turn)", () => {
  it("partial/invalid tool-call JSON args do NOT throw — fall back to {} input", () => {
    // Assistant turn whose tool_call arguments were cut mid-JSON by a truncated
    // stream, followed by the user's "continue" turn.
    const body = {
      messages: [
        { role: "user", content: "list the files" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: '{"cmd":"ls /foo' }, // partial JSON
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "[No response received]" },
        { role: "user", content: "continue" },
      ],
    };

    let result;
    expect(() => { result = buildKiroPayload(MODEL, body, true, {}); }).not.toThrow();

    // The broken assistant turn must still be present in history with a valid
    // (empty) input object rather than having crashed the whole translation.
    const history = result.conversationState.history;
    const assistantWithTool = history.find(
      (h) => h.assistantResponseMessage?.toolUses?.some((t) => t.toolUseId === "call_1")
    );
    expect(assistantWithTool).toBeDefined();
    const toolUse = assistantWithTool.assistantResponseMessage.toolUses.find(
      (t) => t.toolUseId === "call_1"
    );
    expect(toolUse.input).toEqual({}); // malformed args → {} fallback
    expect(toolUse.name).toBe("Bash");
  });

  it("valid tool-call JSON args are still parsed into an object", () => {
    const body = {
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_ok",
              type: "function",
              function: { name: "Bash", arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_ok", content: "ok" },
        { role: "user", content: "continue" },
      ],
    };

    const result = buildKiroPayload(MODEL, body, true, {});
    const history = result.conversationState.history;
    const withTool = history.find(
      (h) => h.assistantResponseMessage?.toolUses?.some((t) => t.toolUseId === "call_ok")
    );
    const toolUse = withTool.assistantResponseMessage.toolUses.find((t) => t.toolUseId === "call_ok");
    expect(toolUse.input).toEqual({ cmd: "ls" });
  });

  it("two consecutive assistant turns are merged (kiro requires alternating roles)", () => {
    // Truncated assistant turn + the retried assistant turn, back-to-back with no
    // user message between — exactly the post-truncation shape.
    const body = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "first half" },
        { role: "assistant", content: "second half" },
        { role: "user", content: "continue" },
      ],
    };

    const result = buildKiroPayload(MODEL, body, true, {});
    const history = result.conversationState.history;

    // No two adjacent assistantResponseMessage entries may remain.
    for (let i = 1; i < history.length; i++) {
      const prevIsAssistant = !!history[i - 1].assistantResponseMessage;
      const curIsAssistant = !!history[i].assistantResponseMessage;
      expect(prevIsAssistant && curIsAssistant).toBe(false);
    }
    // Merged content keeps both halves.
    const merged = history.find((h) => h.assistantResponseMessage?.content?.includes("first half"));
    expect(merged.assistantResponseMessage.content).toContain("second half");
  });

  it("does not throw on an assistant turn with tool_use but no following tool_result", () => {
    // Orphan tool_use at the very end of history (the cut-off turn) + continue.
    const body = {
      messages: [
        { role: "user", content: "do a thing" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "orphan_1", type: "function", function: { name: "Read", arguments: '{"path' } },
          ],
        },
        { role: "user", content: "continue anyway" },
      ],
    };

    let result;
    expect(() => { result = buildKiroPayload(MODEL, body, true, {}); }).not.toThrow();
    expect(result.conversationState.currentMessage.userInputMessage.content).toContain("continue anyway");
  });
});
