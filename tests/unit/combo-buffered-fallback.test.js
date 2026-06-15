import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleComboChat } from "open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

// ---------------------------------------------------------------------------
// SSE body builders. A "complete" stream ends with a genuine terminal marker
// (finish_reason + [DONE]); a "truncated" stream is cut mid-response with no
// terminal marker — exactly the vuz mid-stream-close case.
// ---------------------------------------------------------------------------
function completeSSE(text) {
  const content = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] });
  const finish = JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
  return `data: ${content}\n\ndata: ${finish}\n\ndata: [DONE]\n\n`;
}

function truncatedSSE(text) {
  const content = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] });
  return `data: ${content}\n\n`; // no finish_reason, no [DONE]
}

// HTTP 200 then an error terminal only (e.g. relay surfaces "empty upstream"
// AFTER committing the header). Genuinely ended, but NOT a success — must be
// treated as needing fallback, never returned to the client as a final answer.
function errorTerminalSSE() {
  const err = JSON.stringify({ error: { message: "empty upstream response", type: "upstream_error" } });
  return `data: ${err}\n\ndata: [DONE]\n\n`;
}

// HTTP 200 then only heartbeat comments — bytes flow but no real data payload.
function heartbeatOnlySSE() {
  return `: keepalive\n\n: keepalive\n\n`;
}

function sseResponse(body) {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function readStream(response) {
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

const MODELS = ["kiro/auto", "codex/gpt-5.5"];

describe("Combo buffered fallback (bufferedFallbackEnabled)", () => {
  beforeEach(() => {
    log.info.mockClear();
    log.warn.mockClear();
    log.debug.mockClear();
  });

  it("OFF: pipes the (even truncated) response straight through, calls model once", async () => {
    const handleSingleModel = vi.fn().mockResolvedValueOnce(sseResponse(truncatedSSE("half")));

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: MODELS,
      handleSingleModel,
      log,
      bufferedFallbackEnabled: false,
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    // Straight passthrough: the original truncated body is returned unbuffered.
    const out = await readStream(result);
    expect(out).toContain("half");
  });

  it("ON + model1 truncated → transparently falls back to model2, client gets full answer", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(sseResponse(truncatedSSE("half answ")))
      .mockResolvedValueOnce(sseResponse(completeSSE("complete answer from viber")));

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: MODELS,
      handleSingleModel,
      log,
      bufferedFallbackEnabled: true,
    });

    const out = await readStream(result);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(out).toContain("complete answer from viber");
    expect(out).not.toContain("half answ");
    expect(out).toContain("[DONE]");
  });

  it("ON + model1 complete → returns it, does NOT call model2", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(sseResponse(completeSSE("full answer from vuz")));

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: MODELS,
      handleSingleModel,
      log,
      bufferedFallbackEnabled: true,
    });

    const out = await readStream(result);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(out).toContain("full answer from vuz");
    expect(out).toContain("[DONE]");
  });

  it("ON + all models truncated → emits a retryable error SSE to the client", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValue(sseResponse(truncatedSSE("half")));

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: MODELS,
      handleSingleModel,
      log,
      bufferedFallbackEnabled: true,
    });

    const out = await readStream(result);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(out).toContain("stream_truncated");
  });

  it("ON: response is committed immediately (heartbeat) before the slow body finishes buffering", async () => {
    // The provider returns its 200 header instantly, but the body trickles: the
    // last chunk (and [DONE]) is withheld until `release()` fires. The heartbeat
    // path must return a Response right away — without waiting for the body to
    // finish buffering — so the client connection is committed and kept alive.
    let release;
    const gate = new Promise((r) => { release = r; });
    const slowBody = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "delayed answer" }, finish_reason: null }] })}\n\n`
        ));
        await gate; // body stalls here until released
        controller.enqueue(enc.encode(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
        ));
        controller.close();
      },
    });
    const handleSingleModel = vi.fn().mockResolvedValueOnce(
      new Response(slowBody, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    // handleComboChat must resolve to a Response object WITHOUT waiting for the
    // body buffer to complete (the heartbeat stream is returned immediately).
    const result = await Promise.race([
      handleComboChat({
        body: { stream: true, messages: [{ role: "user", content: "hi" }] },
        models: ["kiro/auto"],
        handleSingleModel,
        log,
        bufferedFallbackEnabled: true,
      }),
      new Promise((r) => setTimeout(() => r("TIMEOUT"), 200)),
    ]);

    expect(result).not.toBe("TIMEOUT");
    expect(result.status).toBe(200);
    release(); // let the body finish so the buffer completes and the stream closes
    const out = await readStream(result);
    expect(out).toContain("delayed answer");
  });

  it("ON + non-streaming request (stream:false) → bypasses buffering entirely", async () => {
    const handleSingleModel = vi.fn().mockResolvedValueOnce(sseResponse(truncatedSSE("half")));

    const result = await handleComboChat({
      body: { stream: false, messages: [{ role: "user", content: "hi" }] },
      models: MODELS,
      handleSingleModel,
      log,
      bufferedFallbackEnabled: true,
    });

    // No buffering: straight passthrough, single call.
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
  });

  it("ON + model1 returns HTTP 200 then an ERROR terminal only → falls back (error is not a successful end)", async () => {
    // The vuz failure mode: 200 header committed, then `event: error` / an error
    // chunk before any real content. A naive terminal check would see the [DONE]
    // and treat it as complete; the success-only detection must NOT, so the
    // buffered loop falls back to model2 instead of returning the error.
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(sseResponse(errorTerminalSSE()))
      .mockResolvedValueOnce(sseResponse(completeSSE("recovered answer")));

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: MODELS,
      handleSingleModel,
      log,
      bufferedFallbackEnabled: true,
    });

    const out = await readStream(result);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(out).toContain("recovered answer");
    expect(out).not.toContain("empty upstream response");
  });

  it("ON + model1 streams only heartbeat comments (no data) → treated as empty, falls back", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(sseResponse(heartbeatOnlySSE()))
      .mockResolvedValueOnce(sseResponse(completeSSE("real content")));

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: MODELS,
      handleSingleModel,
      log,
      bufferedFallbackEnabled: true,
    });

    const out = await readStream(result);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(out).toContain("real content");
  });

  it("ON + upstream hangs (never closes) → deadline truncation fires, falls back to model2", async () => {
    // The exact vuz symptom: 200 header, a content chunk, then the socket hangs
    // forever WITHOUT closing. readBodyWithTimeout's deadline must fire and mark
    // the buffer truncated so the loop falls back — covering the timeout path the
    // original tests never exercised (P9).
    const hangingBody = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "stalled half" }, finish_reason: null }] })}\n\n`
        ));
        // never enqueue a terminal, never close — relies on the deadline.
      },
    });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(hangingBody, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(sseResponse(completeSSE("answer after timeout")));

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: MODELS,
      handleSingleModel,
      log,
      bufferedFallbackEnabled: true,
      bufferTimeoutMs: 1000, // deadline clamps to 1s min — fire fast in test
    });

    const out = await readStream(result);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(out).toContain("answer after timeout");
    expect(out).not.toContain("stalled half");
  }, 15000);
});
