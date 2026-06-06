/**
 * Tests for tool_choice enforcement in openai-to-kiro translator.
 * Story 1.1 — AC#1, #2, #3, #4, #6, #7
 */
import { describe, it, expect } from "vitest";
import { buildKiroPayload } from "open-sse/translator/request/openai-to-kiro.js";

// Minimal tool list used across tests
const TOOLS = [
  { type: "function", function: { name: "restricted_exec", description: "search", parameters: { type: "object", properties: { q: { type: "string" } }, required: [] } } },
  { type: "function", function: { name: "answer", description: "return answer", parameters: { type: "object", properties: { files: { type: "array", items: { type: "string" } } }, required: [] } } },
];

const MESSAGES = [
  { role: "user", content: "Where is auth handled?" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "restricted_exec", arguments: '{"q":"auth"}' } }] },
  { role: "tool", tool_call_id: "c1", content: "src/auth.ts:12: export function authenticate" },
];

function getContent(toolChoice) {
  const payload = buildKiroPayload("claude-sonnet-4.6", { messages: MESSAGES, tools: TOOLS, tool_choice: toolChoice }, false, {});
  return payload.conversationState.currentMessage.userInputMessage.content;
}

// ---------------------------------------------------------------------------
// AC#1: named tool_choice (OpenAI shape)
// ---------------------------------------------------------------------------
describe("AC#1 — named tool_choice (OpenAI shape)", () => {
  it("injects [TOOL DIRECTIVE] naming the tool", () => {
    const content = getContent({ type: "function", function: { name: "answer" } });
    expect(content).toContain("[TOOL DIRECTIVE]");
    expect(content).toContain("`answer`");
    expect(content).toContain("Do not call any other tool");
  });

  it("names restricted_exec when that tool is forced", () => {
    const content = getContent({ type: "function", function: { name: "restricted_exec" } });
    expect(content).toContain("`restricted_exec`");
  });
});

// ---------------------------------------------------------------------------
// AC#1 (cont): named tool_choice (Claude shape)
// ---------------------------------------------------------------------------
describe("AC#1 — named tool_choice (Claude shape)", () => {
  it("injects directive for Claude {type:'tool', name:'answer'}", () => {
    const content = getContent({ type: "tool", name: "answer" });
    expect(content).toContain("[TOOL DIRECTIVE]");
    expect(content).toContain("`answer`");
  });
});

// ---------------------------------------------------------------------------
// AC#2: required / any → generic directive
// ---------------------------------------------------------------------------
describe("AC#2 — required / any tool_choice", () => {
  it("injects generic directive for OpenAI 'required'", () => {
    const content = getContent("required");
    expect(content).toContain("[TOOL DIRECTIVE]");
    expect(content).toContain("You MUST call one of the available tools");
    expect(content).not.toContain("`answer`"); // not named
  });

  it("injects generic directive for Claude {type:'any'}", () => {
    const content = getContent({ type: "any" });
    expect(content).toContain("[TOOL DIRECTIVE]");
    expect(content).not.toContain("`answer`");
  });
});

// ---------------------------------------------------------------------------
// AC#3: auto / none / absent → no directive (no regression)
// ---------------------------------------------------------------------------
describe("AC#3 — auto/none/absent → no directive", () => {
  it("no directive when tool_choice is absent", () => {
    const content = getContent(undefined);
    expect(content).not.toContain("[TOOL DIRECTIVE]");
  });

  it("no directive when tool_choice is 'auto'", () => {
    const content = getContent("auto");
    expect(content).not.toContain("[TOOL DIRECTIVE]");
  });

  it("no directive when tool_choice is 'none'", () => {
    const content = getContent("none");
    expect(content).not.toContain("[TOOL DIRECTIVE]");
  });

  it("no directive when tool_choice is null", () => {
    const content = getContent(null);
    expect(content).not.toContain("[TOOL DIRECTIVE]");
  });

  it("no directive for Claude {type:'auto'}", () => {
    const content = getContent({ type: "auto" });
    expect(content).not.toContain("[TOOL DIRECTIVE]");
  });
});

// ---------------------------------------------------------------------------
// AC#4: tool name not in declared tools list
// ---------------------------------------------------------------------------
describe("AC#4 — tool name not in declared tools", () => {
  it("downgrade named→required when tool is unknown (has other tools)", () => {
    const content = getContent({ type: "function", function: { name: "nonexistent_tool" } });
    expect(content).toContain("[TOOL DIRECTIVE]");
    expect(content).not.toContain("`nonexistent_tool`"); // not named
    expect(content).toContain("You MUST call one of the available tools"); // downgraded
  });

  it("no directive for 'required' when tools list is empty (P1 regression guard)", () => {
    const payload = buildKiroPayload("claude-sonnet-4.6", {
      messages: [{ role: "user", content: "hello" }],
      tools: [],           // ← empty tools
      tool_choice: "required"
    }, false, {});
    const content = payload.conversationState.currentMessage.userInputMessage.content;
    expect(content).not.toContain("[TOOL DIRECTIVE]");
  });

  it("no directive for Claude {type:'any'} when tools list is empty", () => {
    const payload = buildKiroPayload("claude-sonnet-4.6", {
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      tool_choice: { type: "any" }
    }, false, {});
    const content = payload.conversationState.currentMessage.userInputMessage.content;
    expect(content).not.toContain("[TOOL DIRECTIVE]");
  });
});

// ---------------------------------------------------------------------------
// AC#6: tool name in directive matches tool name sent to Kiro (no prefix)
// ---------------------------------------------------------------------------
describe("AC#6 — directive name matches Kiro tool name (no prefix)", () => {
  it("directive uses bare tool name, not prefixed", () => {
    const content = getContent({ type: "function", function: { name: "answer" } });
    // Kiro translator uses no prefix (CLAUDE_OAUTH_TOOL_PREFIX = "")
    expect(content).toContain("`answer`");
    expect(content).not.toContain("`proxy_answer`");
  });
});

// ---------------------------------------------------------------------------
// Directive is the LAST thing in finalContent (appended after all prefixes)
// ---------------------------------------------------------------------------
describe("Directive placement — must be last instruction", () => {
  it("directive is appended at the end of content", () => {
    const content = getContent({ type: "function", function: { name: "answer" } });
    const directiveIdx = content.lastIndexOf("[TOOL DIRECTIVE]");
    expect(directiveIdx).toBeGreaterThan(-1);
    // Nothing meaningful should come after the directive
    const afterDirective = content.slice(directiveIdx + "[TOOL DIRECTIVE]".length).trim();
    expect(afterDirective.length).toBeLessThan(200); // only the short directive text, not more content
  });
});
