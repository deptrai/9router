// Buffered fallback for combo streaming.
//
// Some relay providers (e.g. vuz) return HTTP 200 OK, stream a few chunks, then
// close the TCP socket mid-response WITHOUT a finish signal. Because the 200
// header is committed the instant the stream starts, a normal pass-through pipe
// cannot fall back to the next combo model — the half-answer has already left
// the server. The client (OpenCode) then stops mid-sentence and does NOT retry.
//
// This module buffers the WHOLE translated SSE body server-side before handing
// it to the client. If the buffered stream is truncated (no terminal marker),
// we transparently try the next combo model (vuz → viber) without the client
// ever seeing an error. A heartbeat (SSE comment) keeps the client connection
// alive while buffering, since no bytes flow until the buffer is complete.
//
// Trade-off: the client loses real-time streaming (it waits until the buffer is
// done). Gated behind an admin toggle (bufferedFallbackEnabled), default OFF.

import { STREAM_TTFT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { isSuccessfulTerminalChunk } from "./stream.js";

const HEARTBEAT_INTERVAL_MS = 12000;
const HEARTBEAT_COMMENT = ": keepalive\n\n";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*",
};

// Buffered fallback only makes sense for streaming requests. A request is
// streaming unless the client explicitly set stream:false.
export function isStreamingComboRequest(body) {
  return body?.stream !== false;
}

// Read a ReadableStream fully into a string, bounded by a deadline. Returns
// { text, timedOut, error } — timedOut true means the upstream never closed
// within timeoutMs (treated as a truncation by the caller); error is set when a
// genuine (non-cancel) read failure occurred so the caller can log it and treat
// the result as truncated. An optional abortSignal lets the caller (client
// disconnect) cancel the in-flight read immediately rather than waiting for the
// deadline. The reader is cancelled on timeout/abort so the underlying
// connection is released.
export async function readBodyWithTimeout(body, timeoutMs = STREAM_TTFT_TIMEOUT_MS, abortSignal = null) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let timedOut = false;
  let aborted = false;

  const deadline = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, Math.max(1000, timeoutMs));
  if (deadline.unref) deadline.unref();

  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => {});
  };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (e) {
    // A cancel() from the deadline or abort surfaces here as a read rejection —
    // expected. Any OTHER rejection is a real network error: surface it as both
    // truncation AND an error string so the caller can log it and fall back
    // rather than silently treating a broken stream as complete.
    if (!timedOut && !aborted) return { text, timedOut: true, error: e?.message || String(e) };
  } finally {
    clearTimeout(deadline);
    if (abortSignal) abortSignal.removeEventListener?.("abort", onAbort);
    try { reader.releaseLock(); } catch { /* already released by cancel */ }
  }

  return { text, timedOut: timedOut || aborted, aborted };
}

// Does the buffered SSE text carry at least one real `data:` payload (not just
// heartbeat comments / blank lines)? Byte-length alone is misleading: a stream
// of only `: keepalive` comments has length > 0 but no content. Used so the
// combo fallback distinguishes a genuinely-empty response from one that merely
// kept the socket warm.
function hasSemanticData(rawSSE) {
  if (!rawSSE) return false;
  for (const line of rawSSE.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload && payload !== "[DONE]") return true;
  }
  return false;
}

// Buffer a translated SSE Response and decide whether it was truncated.
// truncated=true when no genuine SUCCESSFUL terminal marker ([DONE] /
// finish_reason / message_stop / response.completed) was seen before the stream
// ended, OR when the read timed out / errored. Error terminals (event: error /
// response.failed / a bare {error:...} chunk) do NOT count as a successful end,
// so a relay that returns HTTP 200 then streams only an error is correctly
// treated as truncated and the caller falls back to the next model. Uses
// isSuccessfulTerminalChunk so detection cannot drift from the stream.js guard.
export async function bufferSSEResponse(response, timeoutMs = STREAM_TTFT_TIMEOUT_MS, abortSignal = null) {
  if (!response?.body) return { rawSSE: "", truncated: true, hasContent: false };

  const { text: rawSSE, timedOut, error } = await readBodyWithTimeout(response.body, timeoutMs, abortSignal);
  if (timedOut || error) return { rawSSE, truncated: true, hasContent: hasSemanticData(rawSSE), error };

  // Scan the WHOLE body (don't break early): a body can carry an error chunk
  // followed by a bare [DONE] (combo's own buildErrorSSE shape, or a relay that
  // appends [DONE] after surfacing an error). The [DONE] alone must NOT mark it
  // successful — an error anywhere means this attempt failed and the caller
  // should fall back. We require a genuine success terminal AND no error.
  let finishSeen = false;
  let sawError = false;
  for (const line of rawSSE.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") { finishSeen = true; continue; }
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload);
      const t = parsed.type || parsed.event;
      if (parsed.error || t === "error" || t === "response.failed" || t === "response.incomplete") {
        sawError = true;
        continue;
      }
      if (isSuccessfulTerminalChunk(parsed)) { finishSeen = true; }
    } catch { /* skip malformed chunk */ }
  }

  return { rawSSE, truncated: sawError || !finishSeen, hasContent: hasSemanticData(rawSSE) };
}

// Build the error SSE payload emitted to the client when every combo model
// truncated or failed. Uses the OpenAI-compatible error shape (not [DONE], which
// would falsely assert success) plus a trailing [DONE] so SDKs close cleanly.
function buildErrorSSE(err) {
  const msg = (err && err.message) || "All combo models failed or truncated mid-stream";
  const payload = JSON.stringify({
    error: { message: msg, type: "upstream_error", code: "stream_truncated" },
  });
  return `data: ${payload}\n\ndata: [DONE]\n\n`;
}

// Commit a 200 SSE response immediately and run `asyncFn` in the background to
// produce the buffered body. While asyncFn works, a heartbeat comment keeps the
// connection alive. asyncFn receives an AbortSignal (fired if the client
// disconnects) and must resolve to { rawSSE } or throw.
//
// Returns a Response directly (handleComboChat returns a Response, not a
// { success, response } wrapper).
export function buildHeartbeatComboResponse(asyncFn) {
  const encoder = new TextEncoder();
  let heartbeatTimer = null;
  const abortController = new AbortController();

  const clearHeartbeat = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  };

  const stream = new ReadableStream({
    start(controller) {
      heartbeatTimer = setInterval(() => {
        try { controller.enqueue(encoder.encode(HEARTBEAT_COMMENT)); }
        catch { clearHeartbeat(); }
      }, HEARTBEAT_INTERVAL_MS);

      Promise.resolve()
        .then(() => asyncFn(abortController.signal))
        .then(({ rawSSE }) => {
          clearHeartbeat();
          if (rawSSE) controller.enqueue(encoder.encode(rawSSE));
          try { controller.close(); } catch { /* already closed */ }
        })
        .catch((err) => {
          clearHeartbeat();
          try { controller.enqueue(encoder.encode(buildErrorSSE(err))); } catch { /* noop */ }
          try { controller.close(); } catch { /* noop */ }
        });
    },
    cancel() {
      clearHeartbeat();
      abortController.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
