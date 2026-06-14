import { describe, it, expect } from "vitest";
import { peekStreamForEmptyUpstream, _internal } from "open-sse/utils/ssePeek.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Build a Response whose body streams the given string chunks as SSE bytes.
function sseResponse(chunks, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function drain(response) {
  if (!response?.body) return "";
  const reader = response.body.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

// The canonical broken stream: role-only delta, then an empty-upstream error.
const EMPTY_UPSTREAM_STREAM = [
  `data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`,
  `event: error\ndata: {"error":{"message":"kiro stream completed with no content (empty upstream response) (ID: abc)","code":"upstream_error","type":"upstream_error"}}\n\n`,
  `data: [DONE]\n\n`,
];

describe("peekStreamForEmptyUpstream — pre-content error detection", () => {
  it("detects empty-upstream error that arrives before any content", async () => {
    const { matched, kind, response } = await peekStreamForEmptyUpstream(sseResponse(EMPTY_UPSTREAM_STREAM));
    expect(kind).toBe("empty");
    expect(matched).toBeTruthy();
    // body must still be replayable (so caller may cancel it cleanly)
    expect(response.body).toBeTruthy();
  });

  it("does NOT flag a healthy stream that emits content first", async () => {
    const healthy = [
      `data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const { matched, kind, response } = await peekStreamForEmptyUpstream(sseResponse(healthy));
    expect(matched).toBeNull();
    expect(kind).toBeNull();
    // replayed body must be byte-complete and unchanged
    const out = await drain(response);
    expect(out).toContain(`"content":"Hello"`);
    expect(out.trim().endsWith("[DONE]")).toBe(true);
  });

  it("does NOT flag when a content block precedes an error (real mid-stream cut, not pre-content)", async () => {
    const withContentThenError = [
      `data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n`,
      `event: error\ndata: {"error":{"message":"empty upstream response"}}\n\n`,
    ];
    const { matched } = await peekStreamForEmptyUpstream(sseResponse(withContentThenError));
    // content already reached the client → must NOT convert to fallback (would dup output)
    expect(matched).toBeNull();
  });

  it("detects overloaded error before content", async () => {
    const overloaded = [
      `event: error\ndata: {"error":{"message":"upstream temporarily unavailable, please try again","type":"overloaded_error"}}\n\n`,
    ];
    const { kind, matched } = await peekStreamForEmptyUpstream(sseResponse(overloaded));
    expect(kind).toBe("overloaded");
    expect(matched).toBeTruthy();
  });

  it("flags a Claude-format empty-upstream error before content", async () => {
    const claude = [
      `event: message_start\ndata: {"type":"message_start","message":{"role":"assistant","content":[]}}\n\n`,
      `event: error\ndata: {"type":"error","error":{"type":"upstream_error","message":"completed with no content (empty upstream response)"}}\n\n`,
    ];
    const { kind, matched } = await peekStreamForEmptyUpstream(sseResponse(claude));
    expect(kind).toBe("empty");
    expect(matched).toBeTruthy();
  });

  it("treats a Claude content_block_delta as healthy output", async () => {
    const claude = [
      `event: message_start\ndata: {"type":"message_start","message":{"role":"assistant","content":[]}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`,
    ];
    const { matched } = await peekStreamForEmptyUpstream(sseResponse(claude));
    expect(matched).toBeNull();
  });

  it("passes through non-ok responses untouched", async () => {
    const r = sseResponse(EMPTY_UPSTREAM_STREAM, { status: 503 });
    const { matched, response } = await peekStreamForEmptyUpstream(r);
    expect(matched).toBeNull();
    expect(response.status).toBe(503);
  });

  it("replays the consumed bytes exactly for a healthy stream split across many chunks", async () => {
    // Split a content delta across tiny chunks to exercise the TextDecoder stream path.
    const full = `data: {"choices":[{"index":0,"delta":{"content":"abcdef"},"finish_reason":null}]}\n\ndata: [DONE]\n\n`;
    const tiny = full.match(/.{1,7}/gs);
    const { matched, response } = await peekStreamForEmptyUpstream(sseResponse(tiny));
    expect(matched).toBeNull();
    const out = await drain(response);
    expect(out).toBe(full);
  });
});

describe("ssePeek internals", () => {
  it("scanForTerminalError stops at first semantic output", () => {
    const text =
      `data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n` +
      `event: error\ndata: {"error":{"message":"empty upstream response"}}\n\n`;
    const r = _internal.scanForTerminalError(text);
    expect(r.sawOutput).toBe(true);
    expect(r.kind).toBeNull();
  });

  it("blockHasSemanticOutput recognizes tool_calls", () => {
    const data = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "f" } }] } }] });
    expect(_internal.blockHasSemanticOutput("", data)).toBe(true);
  });

  it("blockHasSemanticOutput treats finish_reason as a legitimate completion", () => {
    const data = JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
    expect(_internal.blockHasSemanticOutput("", data)).toBe(true);
  });

  it("getCompleteSseBlocks handles CRLF (\\r\\n) block separators without dropping the final block", () => {
    // A relay that emits CRLF endings: the lone error block must still be detected.
    const crlf =
      `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\r\n\r\n` +
      `event: error\r\ndata: {"error":{"message":"empty upstream response"}}\r\n\r\n`;
    const r = _internal.scanForTerminalError(crlf);
    expect(r.kind).toBe("empty");
    expect(r.matched).toBeTruthy();
  });
});

describe("peekStreamForEmptyUpstream — CRLF + abort paths", () => {
  it("detects an empty-upstream error delivered with CRLF endings", async () => {
    const crlf = [
      `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\r\n\r\n`,
      `event: error\r\ndata: {"error":{"message":"completed with no content (empty upstream response)"}}\r\n\r\n`,
    ];
    const { kind, matched } = await peekStreamForEmptyUpstream(sseResponse(crlf));
    expect(kind).toBe("empty");
    expect(matched).toBeTruthy();
  });

  it("returns aborted with no replayable body when the signal is already aborted", async () => {
    const r = sseResponse(EMPTY_UPSTREAM_STREAM);
    const ac = new AbortController();
    ac.abort();
    const { matched, response, aborted } = await peekStreamForEmptyUpstream(r, { signal: ac.signal });
    expect(matched).toBeNull();
    expect(aborted).toBe(true);
    expect(response).toBeNull();
  });

  it("gives up with a short timeout on a stalled body that never sends content", async () => {
    // Body that emits one role-only delta then hangs forever — must not block past timeout.
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(`data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n`));
        // never close, never enqueue more
      },
      cancel() { cancelled = true; },
    });
    const stalled = new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const t0 = Date.now();
    const { aborted } = await peekStreamForEmptyUpstream(stalled, { timeoutMs: 1000 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(aborted).toBe(true);
    expect(cancelled).toBe(true);
  });
});
