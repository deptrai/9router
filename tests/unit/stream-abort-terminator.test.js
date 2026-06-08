import { describe, it, expect } from "vitest";
import { createDisconnectAwareStream } from "open-sse/utils/streamHandler.js";

// A readable that emits the given chunks, then throws `error` on the next read.
function makeErroringReadable(chunks, error) {
  let i = 0;
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.error(error);
      }
    },
  });
}

// A readable that emits chunks then closes cleanly (no error).
function makeClosingReadable(chunks) {
  let i = 0;
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

function makeController() {
  let connected = true;
  return {
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => {},
  };
}

const fakeWritable = { getWriter: () => ({ abort: () => Promise.resolve() }) };

async function collect(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("createDisconnectAwareStream — abort terminator", () => {
  it("emits a Claude error event when upstream aborts mid-stream (stall timeout)", async () => {
    const abortErr = new Error("stream ttft timeout");
    abortErr.name = "AbortError";
    const readable = makeErroringReadable(
      ['event: message_start\ndata: {"type":"message_start"}\n\n'],
      abortErr
    );
    const out = await collect(
      createDisconnectAwareStream({ readable, writable: fakeWritable }, makeController(), "claude")
    );
    expect(out).toContain("event: error");
    expect(out).toContain("\"type\":\"error\"");
    // The pre-abort chunk is still delivered
    expect(out).toContain("message_start");
  });

  it("emits [DONE] sentinel when upstream aborts mid-stream for OpenAI clients", async () => {
    const abortErr = new Error("stream stall timeout");
    abortErr.name = "AbortError";
    const readable = makeErroringReadable(
      ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'],
      abortErr
    );
    const out = await collect(
      createDisconnectAwareStream({ readable, writable: fakeWritable }, makeController(), "openai")
    );
    expect(out).toContain("data: [DONE]");
  });

  it("emits [DONE] when clientFormat is null (default/unknown)", async () => {
    const abortErr = new Error("socket hang up");
    const readable = makeErroringReadable(["data: partial\n\n"], abortErr);
    const out = await collect(
      createDisconnectAwareStream({ readable, writable: fakeWritable }, makeController(), null)
    );
    expect(out).toContain("data: [DONE]");
  });

  it("does NOT inject a terminator on a clean close (normal completion)", async () => {
    const readable = makeClosingReadable([
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const out = await collect(
      createDisconnectAwareStream({ readable, writable: fakeWritable }, makeController(), "claude")
    );
    expect(out).toContain("message_stop");
    expect(out).not.toContain("event: error");
    // No extra [DONE] is fabricated here — the real flush() owns that on success
    expect(out).not.toContain("data: [DONE]");
  });

  it("propagates a real error (not a network close) via controller.error", async () => {
    const realErr = new Error("unexpected boom");
    const readable = makeErroringReadable(["data: x\n\n"], realErr);
    const stream = createDisconnectAwareStream(
      { readable, writable: fakeWritable },
      makeController(),
      "claude"
    );
    await expect(collect(stream)).rejects.toThrow("unexpected boom");
  });
});
