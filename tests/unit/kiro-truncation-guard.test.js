/**
 * Fix #2 — Kiro truncation guard.
 *
 * KiroExecutor.transformEventStreamToSSE() used to ALWAYS fabricate a
 * finish_reason:stop chunk + [DONE] in flush(), even when the upstream AWS
 * EventStream closed mid-turn WITHOUT a messageStopEvent. That benign terminal
 * marker told the downstream SSE layer (stream.js) the turn completed normally,
 * so stream.js's own truncation guard (Fix #1) never fired and the client
 * silently accepted a half-answer as complete.
 *
 * The guard: if content was already emitted (chunkIndex > 0) but no genuine
 * terminal arrived (finishEmitted still false at flush), close WITHOUT a
 * terminal marker so stream.js surfaces a retryable error. An empty stream
 * (no content) still terminates cleanly with finish + [DONE].
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshKiroToken: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

// ---------------------------------------------------------------------------
// Minimal AWS EventStream frame encoder (mirrors parseEventFrame in kiro.js):
//   [0..3]   totalLength (uint32 BE)
//   [4..7]   headersLength (uint32 BE)
//   [8..11]  prelude CRC (not validated by parser)
//   [12..]   headers: nameLen(1) name headerType(1=7/string) valueLen(2 BE) value
//   payload: 12+headersLength .. totalLength-4
//   [last 4] message CRC (not validated by parser)
// ---------------------------------------------------------------------------
function encodeFrame(eventType, payloadObj) {
  const enc = new TextEncoder();
  const name = ":event-type";
  const nameBytes = enc.encode(name);
  const valueBytes = enc.encode(eventType);

  // header = nameLen(1) + name + type(1) + valueLen(2) + value
  const headerLen = 1 + nameBytes.length + 1 + 2 + valueBytes.length;
  const headers = new Uint8Array(headerLen);
  let o = 0;
  headers[o++] = nameBytes.length;
  headers.set(nameBytes, o); o += nameBytes.length;
  headers[o++] = 7; // string type
  headers[o++] = (valueBytes.length >> 8) & 0xff;
  headers[o++] = valueBytes.length & 0xff;
  headers.set(valueBytes, o); o += valueBytes.length;

  const payloadBytes = enc.encode(JSON.stringify(payloadObj));
  const totalLength = 12 + headerLen + payloadBytes.length + 4;

  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headerLen, false);
  view.setUint32(8, 0, false); // prelude CRC (ignored)
  frame.set(headers, 12);
  frame.set(payloadBytes, 12 + headerLen);
  // last 4 bytes (message CRC) left as zeros (ignored)
  return frame;
}

function streamOf(...frames) {
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(f);
      c.close();
    },
  });
}

function kiroResponse(stream) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "Content-Type": "application/vnd.amazon.eventstream" }),
    body: stream,
  };
}

async function readAll(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe("Kiro truncation guard (Fix #2)", () => {
  let executor;
  beforeEach(() => {
    vi.clearAllMocks();
    executor = new KiroExecutor();
  });

  it("content emitted then upstream closes WITHOUT messageStopEvent → no fabricated finish/[DONE]", async () => {
    const stream = streamOf(
      encodeFrame("assistantResponseEvent", { content: "half an answer" })
      // upstream dies here — no messageStopEvent, no metering/context
    );
    proxyAwareFetch.mockResolvedValueOnce(kiroResponse(stream));

    const result = await executor.execute({
      model: "kiro/auto",
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: "tok" },
      signal: null,
      log: null,
    });

    const out = await readAll(result.response);
    // Content reached the client...
    expect(out).toContain("half an answer");
    // ...but the truncated turn must NOT carry a benign terminator.
    expect(out).not.toContain("data: [DONE]");
    expect(out).not.toContain('"finish_reason":"stop"');
  });

  it("content + genuine messageStopEvent → normal finish + [DONE] (unchanged)", async () => {
    const stream = streamOf(
      encodeFrame("assistantResponseEvent", { content: "complete answer" }),
      encodeFrame("messageStopEvent", {})
    );
    proxyAwareFetch.mockResolvedValueOnce(kiroResponse(stream));

    const result = await executor.execute({
      model: "kiro/auto",
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: "tok" },
      signal: null,
      log: null,
    });

    const out = await readAll(result.response);
    expect(out).toContain("complete answer");
    expect(out).toContain("data: [DONE]");
    expect(out).toContain('"finish_reason":"stop"');
  });

  it("empty upstream (no content, no stop) → still terminates cleanly with finish + [DONE]", async () => {
    const stream = streamOf(); // no frames at all
    proxyAwareFetch.mockResolvedValueOnce(kiroResponse(stream));

    const result = await executor.execute({
      model: "kiro/auto",
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: "tok" },
      signal: null,
      log: null,
    });

    const out = await readAll(result.response);
    // No content, but the stream must not hang — clean terminator preserved.
    expect(out).toContain("data: [DONE]");
  });
});
