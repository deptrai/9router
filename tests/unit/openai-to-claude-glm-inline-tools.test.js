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
    expect(stopReason).toBe("tool_use"); // GLM inline tool call → override to tool_use
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

  it("infers Read when model hallucinates its own name as tool name (file_path arg)", () => {
    // GLM-5.2 sometimes emits [TOOL_CALLS]glm-5-2[TOOL_CALLS]{file_path:...}
    const events = collectEvents([
      { id: "chatcmpl-glm13", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]glm-5-2[TOOL_CALLS]{\"file_path\":\"/Users/x/.claude/settings.json\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read"); // inferred from file_path
  });

  it("infers Bash when model hallucinates its own name as tool name (command arg)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm14", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]glm-5-2[TOOL_CALLS]{\"command\":\"grep -r devin /Users/x/.claude\",\"description\":\"search\",\"timeout\":5000}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Bash"); // inferred from command
  });

  it("keeps valid known tool names (no remap)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm15", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]Read[TOOL_CALLS]{\"file_path\":\"/tmp/ok.txt\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses[0].name).toBe("Read");
  });

  it("keeps MCP tool names with double underscore (no remap)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm16", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]mcp__serena__find_symbol[TOOL_CALLS]{\"name\":\"foo\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses[0].name).toBe("mcp__serena__find_symbol");
  });

  it("keeps MCP tool names with colon pattern (no remap)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm17", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]server:tool:action[TOOL_CALLS]{\"x\":1}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses[0].name).toBe("server:tool:action");
  });

  it("infers Edit when model hallucinates name (file_path+old_string+new_string)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm18", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]glm-5-2[TOOL_CALLS]{\"file_path\":\"/a.js\",\"old_string\":\"x\",\"new_string\":\"y\"}" }, finish_reason: "stop" }] },
    ]);
    expect(getToolUseBlocks(events)[0].name).toBe("Edit");
  });

  it("infers Grep when model hallucinates name (pattern arg)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm19", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]glm-5-2[TOOL_CALLS]{\"pattern\":\"foo\"}" }, finish_reason: "stop" }] },
    ]);
    expect(getToolUseBlocks(events)[0].name).toBe("Grep");
  });

  it("infers Glob when model hallucinates name (path+pattern, no file_path)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm20", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]glm-5-2[TOOL_CALLS]{\"path\":\"/src\",\"pattern\":\"*.js\"}" }, finish_reason: "stop" }] },
    ]);
    expect(getToolUseBlocks(events)[0].name).toBe("Glob");
  });

  it("infers WebFetch when model hallucinates name (url arg)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm21", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]glm-5-2[TOOL_CALLS]{\"url\":\"https://x.com\"}" }, finish_reason: "stop" }] },
    ]);
    expect(getToolUseBlocks(events)[0].name).toBe("WebFetch");
  });

  it("infers WebSearch when model hallucinates name (query arg)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm22", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]glm-5-2[TOOL_CALLS]{\"query\":\"latest node\"}" }, finish_reason: "stop" }] },
    ]);
    expect(getToolUseBlocks(events)[0].name).toBe("WebSearch");
  });

  it("infers TodoWrite when model hallucinates name (todos arg)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm23", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]glm-5-2[TOOL_CALLS]{\"todos\":[]}" }, finish_reason: "stop" }] },
    ]);
    expect(getToolUseBlocks(events)[0].name).toBe("TodoWrite");
  });

  it("infers Agent when model hallucinates name (prompt+subagent_type)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm24", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]glm-5-2[TOOL_CALLS]{\"prompt\":\"do x\",\"subagent_type\":\"explore\"}" }, finish_reason: "stop" }] },
    ]);
    expect(getToolUseBlocks(events)[0].name).toBe("Agent");
  });

  it("emits text (not a broken tool_use) when tool name is empty and args are unrecognizable", () => {
    // [TOOL_CALLS][TOOL_CALLS]{...} → empty tool name; args don't match any
    // known shape → must NOT emit a tool_use with name="" (Claude Code rejects).
    const events = collectEvents([
      { id: "chatcmpl-glm25", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS][TOOL_CALLS]{\"foo\":\"bar\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(0); // no tool_use emitted
    const text = getTextDelta(events);
    expect(text).toContain("foo"); // raw content preserved as text
  });

  it("still infers a tool when name is empty but args have a clear shape", () => {
    // empty name + file_path → infer Read (better than dropping)
    const events = collectEvents([
      { id: "chatcmpl-glm26", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS][TOOL_CALLS]{\"file_path\":\"/tmp/x.txt\"}" }, finish_reason: "stop" }] },
    ]);
    expect(getToolUseBlocks(events)[0].name).toBe("Read");
  });
});
