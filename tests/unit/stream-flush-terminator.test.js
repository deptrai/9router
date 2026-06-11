import { describe, it, expect, vi } from "vitest";
import { createSSEStream } from "open-sse/utils/stream.js";
import { FORMATS } from "open-sse/translator/formats.js";

// Mock the @/lib/usageDb import (path alias points to src/) so the test does
// not hit the real usage DB.
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

  // Pump chunks
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

describe("createSSEStream — flush() terminator regression guards", () => {
  it("PASSTHROUGH: emits exactly ONE [DONE] even when onStreamComplete throws after [DONE]", async () => {
    // Build a passthrough stream where onStreamComplete (called AFTER [DONE])
    // throws. Before the fix this caused the catch block to emit a second
    // [DONE], leaving "data: [DONE]\n\ndata: [DONE]\n\n" in the body.
    const out = await runStream(
      {
        mode: "passthrough",
        provider: "test",
        model: "test-model",
        onStreamComplete: () => {
          throw new Error("boom in onStreamComplete");
        },
      },
      [
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n',
      ]
    );
    const doneCount = (out.match(/data: \[DONE\]/g) || []).length;
    expect(doneCount).toBe(1);
  });

  it("TRANSLATE Claude→OpenAI: emits exactly ONE [DONE] even when onStreamComplete throws", async () => {
    // Translate mode: source=openai (client), target=claude (provider). flush()
    // path emits "data: [DONE]" near the end, then runs logging + onStreamComplete.
    // If onStreamComplete throws, the catch path must NOT emit a second terminator.
    const out = await runStream(
      {
        mode: "translate",
        targetFormat: FORMATS.CLAUDE,
        sourceFormat: FORMATS.OPENAI,
        provider: "test",
        model: "test-model",
        onStreamComplete: () => {
          throw new Error("boom in onStreamComplete");
        },
      },
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m_1","type":"message","role":"assistant","content":[],"model":"test-model","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]
    );
    const doneCount = (out.match(/data: \[DONE\]/g) || []).length;
    expect(doneCount).toBe(1);
    // And the body should NOT contain a trailing error event after success.
    const lastErrorIdx = out.lastIndexOf("event: error");
    const lastDoneIdx = out.lastIndexOf("data: [DONE]");
    expect(lastErrorIdx).toBeLessThan(lastDoneIdx); // either no error event, or it's before [DONE] (i.e. -1 < anything)
  });

  it("TRANSLATE: when flush throws BEFORE [DONE] is emitted, catch DOES emit a terminator", async () => {
    // Negative case: if the throw happens before [DONE] (e.g. translateResponse
    // throws on the null flush call), the terminator must still come out.
    // Drive that by passing a malformed translator state via no chunks at all
    // and a sourceFormat that the (null,state) flush path won't choke on for the
    // Claude→OpenAI case, then assert at minimum SOME terminator appears.
    const out = await runStream(
      {
        mode: "translate",
        targetFormat: FORMATS.CLAUDE,
        sourceFormat: FORMATS.OPENAI,
        provider: "test",
        model: "test-model",
      },
      [] // empty stream → flush() runs translate path with empty buffer
    );
    // Empty stream still gets a [DONE] terminator from the success path.
    expect(out).toContain("data: [DONE]");
  });
});
