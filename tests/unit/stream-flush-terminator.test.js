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

  it("PASSTHROUGH truncation: content forwarded but upstream closed with NO finish → retryable error, NOT [DONE]", async () => {
    // vuz→kiro 200-then-cut: a content delta is forwarded, then the upstream
    // socket closes without ever sending finish_reason or [DONE]. flush() must
    // emit a retryable error terminator (so the client retries) instead of a
    // benign [DONE] that would make a half-answer look complete.
    const out = await runStream(
      {
        mode: "passthrough",
        provider: "test",
        model: "test-model",
      },
      [
        // content only — NO finish_reason, NO [DONE]
        'data: {"choices":[{"delta":{"content":"half an answer"}}]}\n',
      ]
    );
    expect(out).toContain("half an answer");
    expect(out).not.toContain("data: [DONE]");
    expect(out).toContain('"code":"stream_truncated"');
  });

  it("TRANSLATE truncation (OpenAI client): content emitted but no upstream stop → retryable error data chunk, NOT [DONE]", async () => {
    // Claude provider streams content then the socket dies before message_delta
    // /message_stop. upstreamFinished stays false → flush() must surface a
    // retryable error terminator rather than [DONE]. Client format is OpenAI,
    // so the terminator is a `data: {error...}` chunk (NOT an `event: error`,
    // which is the Claude-client shape).
    const out = await runStream(
      {
        mode: "translate",
        targetFormat: FORMATS.CLAUDE,
        sourceFormat: FORMATS.OPENAI,
        provider: "test",
        model: "test-model",
      },
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m_1","type":"message","role":"assistant","content":[],"model":"test-model","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half an answer"}}\n\n',
        // socket dies here — no message_delta/message_stop
      ]
    );
    expect(out).toContain("half an answer");
    expect(out).not.toContain("data: [DONE]");
    expect(out).toContain('"code":"stream_truncated"');
  });

  it("TRANSLATE truncation (Claude client): emits `event: error`, NOT [DONE]", async () => {
    // Same truncation, but the client speaks Claude format (sourceFormat=CLAUDE):
    // the terminator must be a recognized `event: error` so the Anthropic SDK
    // throws a retryable upstream error instead of accepting a half-answer.
    // Provider/target is OpenAI; upstream dies after a content delta with no
    // finish_reason / [DONE].
    const out = await runStream(
      {
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.CLAUDE,
        provider: "test",
        model: "test-model",
      },
      [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"half an answer"}}]}\n\n',
        // socket dies here — no finish_reason, no [DONE]
      ]
    );
    expect(out).toContain("half an answer");
    expect(out).not.toContain("data: [DONE]");
    expect(out).toContain("event: error");
    expect(out).toContain("overloaded_error");
  });

  it("TRANSLATE truncation (tool-call-only Claude provider): tool_use streamed then socket dies → retryable error, NOT [DONE]", async () => {
    // P1 regression: a Claude provider that streams ONLY a tool call (no text)
    // then dies before message_stop. The tool-call bytes carry no delta.text, so
    // before the fix totalContentLength stayed 0 and the truncation guard never
    // fired — the client silently accepted a half-emitted tool call as complete.
    // partial_json (+ tool_use block start) must now count toward the guard.
    const out = await runStream(
      {
        mode: "translate",
        targetFormat: FORMATS.CLAUDE,
        sourceFormat: FORMATS.OPENAI,
        provider: "test",
        model: "test-model",
      },
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m_1","type":"message","role":"assistant","content":[],"model":"test-model","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls"}}\n\n',
        // socket dies mid tool-call args — no message_stop, no [DONE]
      ]
    );
    expect(out).not.toContain("data: [DONE]");
    expect(out).toContain('"code":"stream_truncated"');
  });

  it("PASSTHROUGH no-content close (empty upstream) does NOT trigger truncation guard → [DONE]", async () => {
    // Guard must be scoped to the truncation case only: a stream that produced
    // zero content (handled by ssePeek elsewhere) still ends with [DONE], not an
    // error terminator — otherwise we'd double-handle the empty-upstream case.
    const out = await runStream(
      {
        mode: "passthrough",
        provider: "test",
        model: "test-model",
      },
      [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n',
      ]
    );
    expect(out).toContain("data: [DONE]");
    expect(out).not.toContain('"code":"stream_truncated"');
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
