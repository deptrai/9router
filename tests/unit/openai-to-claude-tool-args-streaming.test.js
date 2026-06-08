import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

// Mirror the helper used in openai-to-claude-response-tools.test.js.
function createState() {
  return { toolCalls: new Map(), nextBlockIndex: 0 };
}

function inputJsonDeltas(events) {
  return events
    .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
    .map((e) => e.delta.partial_json);
}

// Helper: drive a tool_use over N "delta arguments" chunks, then a finish chunk.
function driveStreamingToolUse({ toolName, argsChunks, state, idx = 0, id = "toolu_x" }) {
  // Open the tool block — first chunk announces the tool name.
  openaiToClaudeResponse(
    { choices: [{ delta: { tool_calls: [{ index: idx, id, function: { name: toolName } }] } }] },
    state
  );
  const allEvents = [];
  for (const args of argsChunks) {
    const events = openaiToClaudeResponse(
      { choices: [{ delta: { tool_calls: [{ index: idx, function: { arguments: args } }] } }] },
      state
    );
    if (events) allEvents.push(...events);
  }
  // Finish chunk → flushes any buffered (Read) args, emits stop_reason.
  const finishEvents = openaiToClaudeResponse(
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    state
  );
  if (finishEvents) allEvents.push(...finishEvents);
  return allEvents;
}

describe("openaiToClaudeResponse — incremental tool_use args streaming (commit 668b2f7)", () => {
  it("Write: emits ONE input_json_delta per upstream args chunk (no buffering)", () => {
    // The fix's purpose: large Write/Edit args must not sit in a buffer until
    // finish_reason — that silent gap is what idle-times out the client.
    const state = createState();
    const argsChunks = [
      '{"file_path":"/tmp/x.txt"',
      ',"content":"line 1\\n',
      'line 2\\n',
      'line 3"}',
    ];
    const events = driveStreamingToolUse({ toolName: "Write", argsChunks, state });
    const deltas = inputJsonDeltas(events);

    // One delta per chunk, in order, byte-for-byte.
    expect(deltas).toEqual(argsChunks);
    // No accidental fifth delta from the finish block (would be a regression).
    expect(deltas.length).toBe(argsChunks.length);
  });

  it("Edit: same incremental streaming behaviour as Write", () => {
    const state = createState();
    const argsChunks = ['{"file_path":"a.ts","old_string":"foo"', ',"new_string":"bar"}'];
    const events = driveStreamingToolUse({ toolName: "Edit", argsChunks, state });
    expect(inputJsonDeltas(events)).toEqual(argsChunks);
  });

  it("Read: BUFFERS chunks, emits ONCE when JSON parses, no duplicate at finish", () => {
    // Read needs the full JSON to clamp limit/offset. While the JSON is
    // partial, no delta should escape; the moment it parses cleanly the
    // sanitized payload is emitted once.
    const state = createState();
    const argsChunks = [
      '{"file_path":"/x"',           // partial — must NOT emit
      ',"offset":0',                 // still partial — must NOT emit
      ',"limit":50}',                // completes the JSON → ONE emission
    ];
    const events = driveStreamingToolUse({ toolName: "Read", argsChunks, state });
    const deltas = inputJsonDeltas(events);

    expect(deltas.length).toBe(1);
    // Sanitized JSON parses back to valid args.
    const parsed = JSON.parse(deltas[0]);
    expect(parsed.file_path).toBe("/x");
    expect(parsed.offset).toBe(0);
    expect(parsed.limit).toBe(50);
  });

  it("Read: insanely-large limit is clamped (sanitizer still runs after streaming flush)", () => {
    // Regression guard: switching to streaming-on-parse must not bypass the
    // sanitizer that drops bad pages and clamps numeric bounds.
    const state = createState();
    const argsChunks = [
      JSON.stringify({ file_path: "/x", offset: -5, limit: 999999999, pages: "" }),
    ];
    const events = driveStreamingToolUse({ toolName: "Read", argsChunks, state });
    const deltas = inputJsonDeltas(events);
    expect(deltas.length).toBe(1);
    const parsed = JSON.parse(deltas[0]);
    expect(parsed.offset).toBeGreaterThanOrEqual(0);
    expect(parsed.limit).toBeLessThan(999999999);
    expect(parsed.pages).toBeUndefined();
  });

  it("Read with proxy_ prefix: bare-name detection still works (still buffered)", () => {
    // CLAUDE_OAUTH_TOOL_PREFIX = "proxy_". The fix strips it before checking
    // bareName === "Read" — must still take the buffer-and-flush path, not
    // the per-chunk streaming path.
    const state = createState();
    const argsChunks = ['{"file_path":"/d.pdf"', ',"pages":"1-2"}'];
    const events = driveStreamingToolUse({ toolName: "proxy_Read", argsChunks, state });
    const deltas = inputJsonDeltas(events);
    // Buffered → exactly one emission, not one per chunk.
    expect(deltas.length).toBe(1);
    expect(JSON.parse(deltas[0])).toMatchObject({ file_path: "/d.pdf", pages: "1-2" });
  });

  it("non-Read tool with proxy_ prefix: still streams per chunk", () => {
    const state = createState();
    const argsChunks = ['{"command":"ls"', ',"args":["-la"]}'];
    const events = driveStreamingToolUse({ toolName: "proxy_Bash", argsChunks, state });
    expect(inputJsonDeltas(events)).toEqual(argsChunks);
  });

  it("two interleaved tools (different idx): each follows its own buffering rule", () => {
    // Real Claude streams can have multiple tool_use blocks in one assistant
    // message at different `index` values. Verify Write streams while Read
    // (at a different idx) still buffers, with no cross-contamination.
    const state = createState();
    // Open both tools.
    openaiToClaudeResponse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "tw", function: { name: "Write" } }] } }] }, state);
    openaiToClaudeResponse({ choices: [{ delta: { tool_calls: [{ index: 1, id: "tr", function: { name: "Read" } }] } }] }, state);

    // Interleave args.
    const e1 = openaiToClaudeResponse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":"a"' } }] } }] }, state);
    const e2 = openaiToClaudeResponse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"file_path":"b"' } }] } }] }, state);
    const e3 = openaiToClaudeResponse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ',"content":"hi"}' } }] } }] }, state);
    const e4 = openaiToClaudeResponse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '}' } }] } }] }, state);

    const writeDeltas = [...(e1 || []), ...(e3 || [])]
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta" && e.index === 0)
      .map((e) => e.delta.partial_json);
    expect(writeDeltas).toEqual(['{"file_path":"a"', ',"content":"hi"}']);

    // Read emits at most once across e2/e4 — the moment its JSON parses.
    const readDeltas = [...(e2 || []), ...(e4 || [])]
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta" && e.index === 1)
      .map((e) => e.delta.partial_json);
    expect(readDeltas.length).toBe(1);
  });
});
