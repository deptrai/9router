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

  it("sets stop_reason to tool_use when GLM inline tool call emitted", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm10", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]Read[TOOL_CALLS]{\"file_path\":\"/tmp/test.txt\"}" }, finish_reason: "stop" }] },
    ]);

    const stopReason = events.find((e) => e.type === "message_delta")?.delta?.stop_reason;
    // GLM emits [TOOL_CALLS] as text → Windsurf returns finish_reason="stop".
    // Translator must override stop_reason to "tool_use" so Claude Code executes the tool.
    expect(stopReason).toBe("tool_use");
  });

  it("sets stop_reason to end_turn when no tool call (plain text)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm10b", model: "glm-5-2", choices: [{ delta: { content: "Hello world" }, finish_reason: "stop" }] },
    ]);

    const stopReason = events.find((e) => e.type === "message_delta")?.delta?.stop_reason;
    expect(stopReason).toBe("end_turn");
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

  it("rejects model name as tool name (glm-5-2 loop bug)", () => {
    // GLM-5.2 sometimes emits [TOOL_CALLS]glm-5-2[ARGS] hundreds of times
    const events = collectEvents([
      { id: "chatcmpl-glm15b", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]glm-5-2[ARGS][TOOL_CALLS]glm-5-2[ARGS][TOOL_CALLS]glm-5-2[ARGS]" }, finish_reason: "stop" }] },
    ]);

    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(0);
  });

  it("rejects other model names as tool name (sonnet, gpt, claude)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm15c", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]claude-sonnet-4-6[TOOL_CALLS]{}" }, finish_reason: "stop" }] },
    ]);
    expect(getToolUseBlocks(events)).toHaveLength(0);

    const events2 = collectEvents([
      { id: "chatcmpl-glm15d", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]gpt-4[TOOL_CALLS]{}" }, finish_reason: "stop" }] },
    ]);
    expect(getToolUseBlocks(events2)).toHaveLength(0);
  });

  it("does NOT reject real tool names that share prefix with model names", () => {
    // e.g. "Read" should still work, "Bash" should still work
    const events = collectEvents([
      { id: "chatcmpl-glm15e", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Read[TOOL_CALLS]{"file_path":"/tmp/foo"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read");
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

  it("sanitizes Bash args: quotes unquoted glob in --include (session f60b1ef4)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm17b", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Bash[TOOL_CALLS]{"command":"grep -r MCP /Users/luisphan --include=*.js --include=*.yaml"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.command).toContain("--include='*.js'");
    expect(parsed.command).toContain("--include='*.yaml'");
    expect(parsed.command).not.toContain("--include=*.js");
  });

  it("sanitizes Bash args: quotes unquoted glob in --exclude=*", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm17c", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Bash[TOOL_CALLS]{"command":"grep -r devin /Users/luisphan --exclude=*"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.command).toContain("--exclude='*'");
    expect(parsed.command).not.toContain("--exclude=*");
  });

  it("sanitizes Bash args: does NOT quote already-quoted globs", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm17d", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]Bash[TOOL_CALLS]{\"command\":\"grep -r MCP /Users/luisphan --include='*.js'\"}" }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    // Already quoted — should not double-quote
    expect(parsed.command).toContain("--include='*.js'");
    expect(parsed.command).not.toContain("--include=''*.js''");
  });

  it("sanitizes Bash args: does NOT touch commands without globs", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm17e", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Bash[TOOL_CALLS]{"command":"ls -la /tmp"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.command).toBe("ls -la /tmp");
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

  it("sanitizes Agent args: synthesize prompt when completely empty args", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm25", model: "glm-5-2", choices: [{ delta: { content: "[TOOL_CALLS]Agent[TOOL_CALLS]{}" }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(typeof parsed.description).toBe("string");
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(typeof parsed.prompt).toBe("string");
    expect(parsed.prompt.length).toBeGreaterThan(0);
  });

  it("sanitizes Agent args: detect 3-field same value (session 066170b1)", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm26", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Agent[TOOL_CALLS]{"subagent_type":"general-purpose","description":"general-purpose","prompt":"general-purpose"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.subagent_type).toBe("general-purpose");
    // description + prompt should be different from subagent_type now
    expect(parsed.description).not.toBe("general-purpose");
    expect(parsed.prompt).not.toBe("general-purpose");
    expect(parsed.prompt).toContain("general-purpose");
  });

  it("sanitizes Agent args: detect description===prompt===generic (session 89893ae0)", () => {
    // Sonnet 4.6 via windsurf hallucinates Agent args with both fields = "Agent task"
    const events = collectEvents([
      { id: "chatcmpl-glm27", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]Agent[TOOL_CALLS]{"description":"Agent task","prompt":"Agent task"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    // prompt should be synthesized to something meaningful
    expect(parsed.prompt).not.toBe("Agent task");
    expect(parsed.prompt.length).toBeGreaterThan(20);
    expect(parsed.prompt.toLowerCase()).toContain("explore");
  });

  it("sanitizes Agent args: detect description===prompt===generic 'task'", () => {
    const events = collectEvents([
      { id: "chatcmpl-glm27b", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]Agent[TOOL_CALLS]{"description":"task","prompt":"task"}' }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.prompt).not.toBe("task");
    expect(parsed.prompt.length).toBeGreaterThan(20);
  });

  it("sanitizes Agent args: does NOT touch meaningful description===prompt", () => {
    // If both fields are the same but contain a real task, leave them alone
    const realTask = "Find all auth-related files in the codebase and report their paths";
    const events = collectEvents([
      { id: "chatcmpl-glm27c", model: "claude-sonnet-4-6", choices: [{ delta: { content: `[TOOL_CALLS]Agent[TOOL_CALLS]{"description":"${realTask}","prompt":"${realTask}"}` }, finish_reason: "stop" }] },
    ]);

    const inputs = getToolUseInputs(events);
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.prompt).toBe(realTask);
    expect(parsed.description).toBe(realTask);
  });

  it("F22: maps windsurf tool name rg→Grep with string args (Sonnet via windsurf)", () => {
    const events = collectEvents([
      { id: "chatcmpl-f22a", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]rg[TOOL_CALLS]"devin"' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Grep");
    expect(JSON.parse(inputs[0]).pattern).toBe("devin");
  });

  it("F22: maps rg→Grep with command-style args", () => {
    const events = collectEvents([
      { id: "chatcmpl-f22b", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]rg[TOOL_CALLS]rg "mcp" --max-results 10' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Grep");
    expect(JSON.parse(inputs[0]).pattern).toBe("mcp");
  });

  it("F22: maps bash→Bash with command args", () => {
    const events = collectEvents([
      { id: "chatcmpl-f22c", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]bash[TOOL_CALLS]ls -la /tmp' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Bash");
    expect(JSON.parse(inputs[0]).command).toBe("ls -la /tmp");
  });

  it("F22: maps read→Read with file path args", () => {
    const events = collectEvents([
      { id: "chatcmpl-f22d", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]read[TOOL_CALLS]/tmp/foo.txt' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read");
    expect(JSON.parse(inputs[0]).file_path).toBe("/tmp/foo.txt");
  });

  it("F22: multiple rg tool calls in one response (Sonnet pattern)", () => {
    const events = collectEvents([
      { id: "chatcmpl-f22e", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]rg[TOOL_CALLS]rg mcp[TOOL_CALLS]rg[TOOL_CALLS]rg devin[TOOL_CALLS]rg[TOOL_CALLS]rg config' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    expect(toolUses.length).toBeGreaterThanOrEqual(1);
    // All should be Grep
    for (const tu of toolUses) expect(tu.name).toBe("Grep");
  });

  it("F24: swaps prose tool name with real tool name (Sonnet session 38f24236)", () => {
    // Sonnet emits: [TOOL_CALLS]I'll help you...[TOOL_CALLS]Grep{"pattern":"mcp"}
    // Prose is in tool name position, real tool name is after second marker
    const events = collectEvents([
      { id: "chatcmpl-f24a", model: "claude-sonnet-4-6", choices: [{ delta: { content: "[TOOL_CALLS]I'll help you understand the MCP setup. Let me explore the codebase.[TOOL_CALLS]Grep{\"pattern\":\"mcp\"}" }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Grep");
    expect(JSON.parse(inputs[0]).pattern).toBe("mcp");
    // Prose should be emitted as text, not lost
    const text = getTextDelta(events);
    expect(text).toContain("I'll help you understand");
  });

  it("F24: swaps prose with real tool name + no JSON args", () => {
    // [TOOL_CALLS]prose[TOOL_CALLS]agent__explore__codebase-memory__index_repository
    const events = collectEvents([
      { id: "chatcmpl-f24b", model: "claude-sonnet-4-6", choices: [{ delta: { content: "[TOOL_CALLS]Let me explore the codebase to find MCP configs.[TOOL_CALLS]agent__explore__codebase-memory__index_repository" }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("agent__explore__codebase-memory__index_repository");
    const text = getTextDelta(events);
    expect(text).toContain("Let me explore the codebase");
  });

  it("F24: does NOT swap when tool name is short (no prose)", () => {
    // Normal: [TOOL_CALLS]Read[TOOL_CALLS]{json} — Read has no spaces, should NOT swap
    const events = collectEvents([
      { id: "chatcmpl-f24c", model: "glm-5-2", choices: [{ delta: { content: '[TOOL_CALLS]Read[TOOL_CALLS]{"file_path":"/tmp/foo"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read");
  });

  it("F25: infers Bash from [TOOL_CALLS]{command:...} (missing tool name)", () => {
    const events = collectEvents([
      { id: "chatcmpl-f25a", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"command": "ls -la /tmp/"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Bash");
    expect(JSON.parse(inputs[0]).command).toBe("ls -la /tmp/");
  });

  it("F25: infers Read from [TOOL_CALLS]\\n[TOOL_CALLS]{file_path:...} (empty tool name)", () => {
    const events = collectEvents([
      { id: "chatcmpl-f25b", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]\n[TOOL_CALLS]{"file_path":"/Users/luisphan/Documents/9router/src/lib/mcp/server.js"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read");
    expect(JSON.parse(inputs[0]).file_path).toContain("mcp/server.js");
  });

  it("F25: infers Grep from {pattern:...} (missing tool name)", () => {
    const events = collectEvents([
      { id: "chatcmpl-f25c", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"pattern":"mcp","path":"/src"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Grep");
  });

  it("F25: infers Serena find_symbol from {find_symbol:...}", () => {
    const events = collectEvents([
      { id: "chatcmpl-f25d", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"find_symbol":{"symbol":"mcp","include_body":false}}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("mcp__serena__find_symbol");
  });

  it("F25: infers Agent from {prompt,description} (missing tool name)", () => {
    const events = collectEvents([
      { id: "chatcmpl-f25e", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"prompt":"find mcp configs","description":"search mcp"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Agent");
  });

  it("F25: does NOT infer from unknown args keys → emits raw text", () => {
    const events = collectEvents([
      { id: "chatcmpl-f25f", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"unknown_key":"value"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(0);
  });

  it("F26: infers Serena find_symbol from {tool,action} envelope + remaps args", () => {
    // Run 1 pattern: [TOOL_CALLS]{"tool":"serena","action":"find_symbol","name":"mcp","workspace":"/repo","include_body":false}
    const events = collectEvents([
      { id: "chatcmpl-f26a", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"tool": "serena", "action": "find_symbol", "name": "mcp", "workspace": "/Users/luisphan/Documents/9router", "include_body": false}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("mcp__serena__find_symbol");
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.symbol).toBe("mcp");
    expect(parsed.include_body).toBe(false);
    // Should NOT have tool/action wrapper keys
    expect(parsed.tool).toBeUndefined();
    expect(parsed.action).toBeUndefined();
  });

  it("F26: infers context-engine from {tool,action} envelope + remaps args", () => {
    const events = collectEvents([
      { id: "chatcmpl-f26b", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"tool":"context-engine","action":"codebase-retrieval","query":"mcp","workspace":"/repo"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("mcp__vibervn-context-engine__codebase-retrieval");
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.query).toBe("mcp");
    expect(parsed.workspace_full_path).toBe("/repo");
  });

  it("F27: detects raw rg command in text → synthesizes Grep", () => {
    // Run 4 pattern: prose + rg "mcp" /path --exclude-dir tests
    const events = collectEvents([
      { id: "chatcmpl-f27a", model: "claude-sonnet-4-6", choices: [{ delta: { content: 'I need to understand the MCP setup.rg "mcp" /Users/luisphan/Documents/9router --exclude-dir tests --exclude-dir test 2> /dev/null' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Grep");
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.pattern).toBe("mcp");
    expect(parsed.path).toContain("9router");
  });

  it("F27: detects raw cat command in text → synthesizes Read", () => {
    const events = collectEvents([
      { id: "chatcmpl-f27b", model: "claude-sonnet-4-6", choices: [{ delta: { content: 'Let me check that file.cat /tmp/config.json' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read");
    expect(JSON.parse(inputs[0]).file_path).toBe("/tmp/config.json");
  });

  it("F27: does NOT false-positive on prose mentioning rg", () => {
    // "I used rg to search" — no quoted pattern + path → no detection
    const events = collectEvents([
      { id: "chatcmpl-f27c", model: "claude-sonnet-4-6", choices: [{ delta: { content: 'I used rg to search for the pattern but it did not work.' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(0);
  });

  it("F27: does NOT false-positive on prose with quoted string after rg", () => {
    // "rg is a tool" — "tool" is not a path → no detection
    const events = collectEvents([
      { id: "chatcmpl-f27d", model: "claude-sonnet-4-6", choices: [{ delta: { content: 'The rg "search" is not a command here.' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    expect(toolUses).toHaveLength(0);
  });

  it("F28: suppresses [TOOL_CALLS]claude-sonnet-4-6[ARGS] model name loop (Sonnet)", () => {
    // Sonnet emits its own model name as tool name with [ARGS] marker
    const events = collectEvents([
      { id: "chatcmpl-f28a", model: "claude-sonnet-4-6", choices: [{ delta: { content: "[TOOL_CALLS]claude-sonnet-4-6[ARGS]\nNow I need to understand how MCP tools are defined." }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const text = getTextDelta(events);
    expect(toolUses).toHaveLength(0);
    // Should NOT emit the [TOOL_CALLS]claude-sonnet-4-6[ARGS] garbage
    expect(text).not.toContain("[TOOL_CALLS]");
    expect(text).not.toContain("claude-sonnet-4-6");
    // Should preserve the useful prose after [ARGS]
    expect(text).toContain("Now I need to understand");
  });

  it("F28: suppresses multiple model name loops in one response", () => {
    const events = collectEvents([
      { id: "chatcmpl-f28b", model: "claude-sonnet-4-6", choices: [{ delta: { content: "[TOOL_CALLS]claude-sonnet-4-6[ARGS]\nProse 1.[TOOL_CALLS]claude-sonnet-4-6[ARGS]\nProse 2.[TOOL_CALLS]claude-sonnet-4-6[ARGS]" }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const text = getTextDelta(events);
    expect(toolUses).toHaveLength(0);
    expect(text).not.toContain("[TOOL_CALLS]");
    expect(text).not.toContain("claude-sonnet-4-6");
    expect(text).toContain("Prose 1");
    expect(text).toContain("Prose 2");
  });

  it("F29: infers Skill from {skill,args} envelope + remaps args", () => {
    // Run 3 pattern: [TOOL_CALLS]{"skill":"codebase-memory","args":{"query":"MCP|mcp","mode":"calls","limit":10}}
    const events = collectEvents([
      { id: "chatcmpl-f29a", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"skill": "codebase-memory", "args": {"query": "MCP|mcp", "mode": "calls", "limit": 10}}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Skill");
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.command).toBe("invoke");
    expect(parsed.skill).toBe("codebase-memory");
    expect(parsed.query).toBe("MCP|mcp");
  });

  it("F29: infers Skill from {skill} without args envelope", () => {
    const events = collectEvents([
      { id: "chatcmpl-f29b", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"skill": "devin-for-terminal"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Skill");
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.command).toBe("invoke");
    expect(parsed.skill).toBe("devin-for-terminal");
  });

  it("F30: infers Bash from {cmd,tool:Bash} envelope", () => {
    // Run 2 pattern: [TOOL_CALLS]{"cmd":"grep -r 'mcp' /path","tool":"Bash"}
    const events = collectEvents([
      { id: "chatcmpl-f30a", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"cmd": "grep -r \'mcp\' /Users/luisphan/Documents/9router --exclude-dir .git,.claude,node_modules,test", "exclude_dir": "test,tests", "tool": "Bash"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Bash");
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.command).toContain("grep -r");
    expect(parsed.tool).toBeUndefined();
    expect(parsed.cmd).toBeUndefined();
  });

  it("F30: infers Read from {cmd:'cat /file',tool:Read} envelope", () => {
    const events = collectEvents([
      { id: "chatcmpl-f30b", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"cmd": "cat /Users/luisphan/.claude/settings.json", "tool": "Read"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Read");
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.file_path).toBe("/Users/luisphan/.claude/settings.json");
  });

  it("F30: infers Bash from {cmd} without tool wrapper", () => {
    // Run 3 pattern: [TOOL_CALLS]{"cmd":"grep -r 'mcp' /path"}
    const events = collectEvents([
      { id: "chatcmpl-f30c", model: "claude-sonnet-4-6", choices: [{ delta: { content: '[TOOL_CALLS]{"cmd":"grep -r \'mcp\' --exclude-dir=\'test*,tests*\' /Users/luisphan/Documents/9router"}' }, finish_reason: "stop" }] },
    ]);
    const toolUses = getToolUseBlocks(events);
    const inputs = getToolUseInputs(events);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Bash");
    const parsed = JSON.parse(inputs[0]);
    expect(parsed.command).toContain("grep -r");
  });
});
