import { describe, it, expect, vi } from "vitest";
import { createSSEStream } from "open-sse/utils/stream.js";
import { FORMATS } from "open-sse/translator/formats.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

const enc = new TextEncoder();
const dec = new TextDecoder();

async function runStream(opts, chunks) {
  const tx = createSSEStream(opts);
  const writer = tx.writable.getWriter();
  const reader = tx.readable.getReader();
  (async () => {
    for (const c of chunks) await writer.write(enc.encode(c));
    await writer.close();
  })().catch(() => {});
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

async function runStreamWithCompletion(opts, chunks) {
  let completion = null;
  const out = await runStream({
    ...opts,
    onStreamComplete: (content, usage, ttftAt) => {
      completion = { content, usage, ttftAt };
    },
  }, chunks);
  return { out, completion };
}

describe("createSSEStream — transform() per-line resilience", () => {
  it("TRANSLATE: a single malformed/garbage line does not kill the stream", async () => {
    // The translate-mode transform() wraps per-line work in try/catch so one
    // bad chunk is skipped, not fatal. Feed a valid sequence with a garbage
    // line spliced in the middle; the stream must still terminate cleanly.
    const out = await runStream(
      {
        mode: "translate",
        targetFormat: FORMATS.CLAUDE,
        sourceFormat: FORMATS.OPENAI,
        provider: "test",
        model: "test-model",
      },
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"test-model","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        // Garbage line that is "data:" prefixed but whose payload is not the
        // shape the translator expects — must be skipped, not throw fatally.
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]
    );
    // Stream survived and terminated.
    expect(out).toContain("data: [DONE]");
    // Exactly one terminator (no double-emit from a crash path).
    expect((out.match(/data: \[DONE\]/g) || []).length).toBe(1);
  });

  it("PASSTHROUGH: non-JSON data line is forwarded verbatim, stream still ends", async () => {
    const out = await runStream(
      { mode: "passthrough", provider: "test", model: "test-model" },
      [
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
        'data: not-json-garbage\n',
        'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n',
      ]
    );
    expect(out).toContain("data: [DONE]");
    expect((out.match(/data: \[DONE\]/g) || []).length).toBe(1);
  });

  it("TRANSLATE Codex Responses→Claude: tool-call-only streams are not recorded as empty", async () => {
    const { out, completion } = await runStreamWithCompletion(
      {
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.CLAUDE,
        provider: "codex",
        model: "gpt-5.5",
      },
      [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"Bash"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"cmd\\":\\"git status\\"}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"Bash"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":4}}}\n\n',
      ]
    );

    expect(out).toContain("data: [DONE]");
    expect(completion.content.content).toContain("[tool_call:Bash]");
    expect(completion.content.content).toContain("git status");
  });
});
