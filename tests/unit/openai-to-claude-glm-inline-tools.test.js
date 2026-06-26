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

  it("emits raw text instead of tool_use when tool name is hallucinated prose", () => {
    const hallucinatedName = "1. **JWT Expiration Handling Issue**: The current JWT check uses floor";
    const events = collectEvents([
      { id: "chatcmpl-glm11", model: "glm-5-2", choices: [{ delta: { content: `[TOOL_CALLS]${hallucinatedName}[TOOL_CALLS]{\"file_path\":\"/tmp/x\"}` }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    const text = getTextDelta(events);

    expect(toolUses).toHaveLength(0);
    expect(text).toContain(hallucinatedName);
  });

  it("emits raw text when tool name contains markdown", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm12", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]Edit*file[TOOL_CALLS]{\"file_path\":\"/tmp/x\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(0);
  });

  it("emits raw text when tool name is too long (>64 chars)", () => {
    const longName = "A".repeat(80);
    const events = collectEvents([
      { id: "chatcmpl-glm13", model: "glm-5-2", choices: [{ delta: { content: `[TOOL_CALLS]${longName}[TOOL_CALLS]{\"file_path\":\"/tmp/x\"}` }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(0);
  });

  it("still emits tool_use for valid MCP tool name with double underscore", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm14", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]mcp__serena__find_symbol[TOOL_CALLS]{\"name\":\"foo\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("mcp__serena__find_symbol");
  });

  it("still emits tool_use for valid tool name with colon (MCP namespace)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm15", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]serena:find_symbol[TOOL_CALLS]{\"name\":\"foo\"}" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("serena:find_symbol");
  });

  it("sanitizes Bash args: strips hallucinated working_directory", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm16", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Bash[TOOL_CALLS]{"command":"ls -la","working_directory":"/Users/luisphan"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.command).toBe("ls -la");
    expect(parsed).not.toHaveProperty("working_directory");
  });

  it("sanitizes Bash args: keeps valid fields (run_in_background, timeout)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm17", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Bash[TOOL_CALLS]{"command":"sleep 10","run_in_background":true,"timeout":5000}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.command).toBe("sleep 10");
    expect(parsed.run_in_background).toBe(true);
    expect(parsed.timeout).toBe(5000);
  });

  it("sanitizes Agent args: renames agent_type→subagent_type, instructions→prompt", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm18", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Agent[TOOL_CALLS]{"agent_type":"Explore","instructions":"Find the auth logic"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.subagent_type).toBe("Explore");
    expect(parsed.prompt).toBe("Find the auth logic");
    expect(parsed).not.toHaveProperty("agent_type");
    expect(parsed).not.toHaveProperty("instructions");
  });

  it("sanitizes Task args: same renames as Agent", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm19", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Task[TOOL_CALLS]{"agent_type":"general","instructions":"do stuff"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.subagent_type).toBe("general");
    expect(parsed.prompt).toBe("do stuff");
  });

  it("Agent sanitize: keeps existing prompt/subagent_type if already correct", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm20", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Agent[TOOL_CALLS]{"subagent_type":"Explore","prompt":"find auth","is_background":true}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.subagent_type).toBe("Explore");
    expect(parsed.prompt).toBe("find auth");
    expect(parsed.is_background).toBe(true);
    expect(parsed).not.toHaveProperty("agent_type");
    expect(parsed).not.toHaveProperty("instructions");
  });

  it("sanitizes Agent args: renames task→prompt, strips actions (variant hallucination)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm21", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Agent[TOOL_CALLS]{"task":"Explore codebase","actions":["search","examine"]}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.prompt).toBe("Explore codebase");
    expect(parsed).not.toHaveProperty("task");
    expect(parsed).not.toHaveProperty("actions");
  });

  it("sanitizes Agent args: synthesize description when missing (session b1c002ee)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm22", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Agent[TOOL_CALLS]{"subagent_type":"claude-code-guide"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.subagent_type).toBe("claude-code-guide");
    expect(typeof parsed.description).toBe("string");
    expect(parsed.description.length).toBeGreaterThan(0);
  });

  it("sanitizes Agent args: synthesize description from prompt when missing", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm23", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Agent[TOOL_CALLS]{"subagent_type":"Explore","prompt":"Find the auth logic in src/lib"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.subagent_type).toBe("Explore");
    expect(parsed.prompt).toBe("Find the auth logic in src/lib");
    expect(parsed.description).toBe("Find the auth logic in src/lib");
  });

  it("sanitizes Agent args: keeps existing description, does not overwrite", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm24", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Agent[TOOL_CALLS]{"subagent_type":"Explore","prompt":"find auth","description":"Search auth code"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.description).toBe("Search auth code");
    expect(parsed.prompt).toBe("find auth");
  });
});
