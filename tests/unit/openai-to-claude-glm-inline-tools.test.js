import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

function createState() {
  return { toolCalls: new Map(), nextBlockIndex: 0 };
}

function collectEvents(chunks) {
  const state = createState();
  const all = [];
  for (const chunk of chunks) {
    const events = openaiToClaudeResponse(chunk, state);
    if (events) all.push(...events);
  }
  return all;
}

function getTextDelta(events) {
  return events
    .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
    .map((e) => e.delta.text)
    .join("");
}

function getToolUseBlocks(events) {
  return events
    .filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use")
    .map((e) => e.content_block);
}

function getToolUseInputs(events) {
  return events
    .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
    .map((e) => e.delta.partial_json);
}

describe("openaiToClaudeResponse GLM-5.2 inline tool calls", () => {
  it("parses [TOOL_CALLS]name[TOOL_CALLS]{json} into tool_use block", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm1", model: "glm-5-2", choices: [{ delta: { content: "Using Read tool to read /tmp/test.txt.[TOOL_CALLS]Read[TOOL_CALLS]{\"file_path\":\"/tmp/test.txt\"}" }, finish_reason: "stop" }] },
    ]);

    const text = getTextDelta(events);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);

    expect(text).toBe("Using Read tool to read /tmp/test.txt.");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read");
    expect(toolUses[0].type).toBe("tool_use");
    expect(JSON.parse(inputs[0])).toEqual({ file_path: "/tmp/test.txt" });
  });

  it("parses [TOOL_CALLS]name[ARGS]{json} variant", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm2", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]mcp__vibervn-context-engine__codebase-retrieval[ARGS]{\"workspace_full_path\":\"/repo\",\"query\":\"subscription\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);

    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("mcp__vibervn-context-engine__codebase-retrieval");
    expect(JSON.parse(inputs[0])).toEqual({ workspace_full_path: "/repo", query: "subscription" });
  });

  it("handles tool call split across multiple chunks", () => {
    const full = "Let me read that.[TOOL_CALLS]Read[TOOL_CALLS]{\"file_path\":\"/tmp/x.txt\"}";
    const chunks = [
      { id: "chatcmpl-glm3", model: "glm-5-2", choices: [{ delta: { content: full.slice(0, 20) } }] },
      { id: "chatcmpl-glm3", model: "glm-5-2", choices: [{ delta: { content: full.slice(20, 45) } }] },
      { id: "chatcmpl-glm3", model: "glm-5-2", choices: [{ delta: { content: full.slice(45) }, finish_reason: "stop" }] },
    ];
    const events = collectEvents(chunks);

    const text = getTextDelta(events);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);

    expect(text).toBe("Let me read that.");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read");
    expect(JSON.parse(inputs[0])).toEqual({ file_path: "/tmp/x.txt" });
  });

  it("handles [TOOL_CALLS] marker split across chunks", () => {
    const chunks = [
      { id: "chatcmpl-glm4", model: "glm-5-2", choices: [{ delta: { content: "Read this.[TOOL_" } }] },
      { id: "chatcmpl-glm4", model: "glm-5-2", choices: [{ delta: { content: "CALLS]Read[TOOL_CALLS]{\"file_path\":\"/tmp/y.txt\"}" }, finish_reason: "stop" }] },
    ];
    const events = collectEvents(chunks);

    const text = getTextDelta(events);
    const toolUses = getToolUseBlocks(events);

    expect(text).toBe("Read this.");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read");
  });

  it("handles multiple inline tool calls in one response", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm5", model: "glm-5-2", choices: [{ delta: { content: "First read this.[TOOL_CALLS]Read[TOOL_CALLS]{\"file_path\":\"/a.txt\"}Then write that.[TOOL_CALLS]Write[TOOL_CALLS]{\"file_path\":\"/b.txt\",\"content\":\"hi\"}" }, finish_reason: "stop" }] },
    ]);

    const text = getTextDelta(events);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);

    expect(text).toBe("First read this.Then write that.");
    expect(toolUses).toHaveLength(2);
    expect(toolUses[0].name).toBe("Read");
    expect(toolUses[1].name).toBe("Write");
    expect(JSON.parse(inputs[0])).toEqual({ file_path: "/a.txt" });
    expect(JSON.parse(inputs[1])).toEqual({ file_path: "/b.txt", content: "hi" });
  });

  it("handles JSON args with nested braces and strings", () => {
    const args = '{"file_path":"/tmp/x","options":{"limit":100,"offset":0},"meta":"has } brace"}';
    const events = collectEvents([
      { id: "chatcmpl-glm6", model: "glm-5-2", choices: [{ delta: { content: `[TOOL_CALLS]Read[TOOL_CALLS]${args}` }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);

    expect(toolUses).toHaveLength(1);
    expect(JSON.parse(inputs[0])).toEqual({
      file_path: "/tmp/x",
      options: { limit: 100, offset: 0 },
      meta: "has } brace",
    });
  });

  it("emits plain text when no tool call marker present", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm7", model: "glm-5-2", choices: [{ delta: { content: "Just a normal response with no tool calls." }, finish_reason: "stop" }] },
    ]);

    const text = getTextDelta(events);
    const toolUses = getToolUseBlocks(events);

    expect(text).toBe("Just a normal response with no tool calls.");
    expect(toolUses).toHaveLength(0);
  });

  it("flushes incomplete buffer as text at finish", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm8", model: "glm-5-2", choices: [{ delta: { content: "Partial [TOOL_CALLS]Read[TOOL_" }, finish_reason: "stop" }] },
    ]);

    const text = getTextDelta(events);
    const toolUses = getToolUseBlocks(events);

    expect(text).toBe("Partial [TOOL_CALLS]Read[TOOL_");
    expect(toolUses).toHaveLength(0);
  });

  it("strips Claude OAuth proxy_ prefix from tool name", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm9", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]proxy_Read[TOOL_CALLS]{\"file_path\":\"/tmp/z.txt\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses[0].name).toBe("Read");
  });

  it("sets stop_reason to tool_use when tool call emitted", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm10", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]Read[TOOL_CALLS]{\"file_path\":\"/tmp/test.txt\"}" }, finish_reason: "stop" }] },
    ]);

    const stopReason = events.find((e) => e.type === "message_delta")?.delta?.stop_reason;
    expect(stopReason).toBe("end_turn"); // finish_reason "stop" → end_turn (router may override downstream)
  });

  it("parses [TOOL_CALLS]name: {json} colon-format variant", () => {
    // Some models emit colon separator instead of second [TOOL_CALLS] marker
    const events = collectEvents([
      { id: "chatcmpl-glm11", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]Read: {\"file_path\":\"/tmp/colon.txt\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read");
    expect(JSON.parse(inputs[0])).toEqual({ file_path: "/tmp/colon.txt" });
  });

  it("parses [TOOL_CALLS]name: {json} with whitespace before brace", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm12", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]Write:  {\"file_path\":\"/tmp/w.txt\",\"content\":\"hi\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Write");
    expect(JSON.parse(inputs[0])).toEqual({ file_path: "/tmp/w.txt", content: "hi" });
  });
});
