// Peek the head of a streaming SSE body to detect upstream errors that arrive
// AFTER a 200-OK header but BEFORE any real content. The canonical case:
//
//   data: {... delta:{"role":"assistant"}}           ← role-only, no content yet
//   event: error
//   data: {"error":{"message":"kiro stream completed with no content
//                              (empty upstream response)", ...}}
//   data: [DONE]
//
// When 9router forwards a 200 whose stream only ever emits a role delta and then
// an error, the client (Claude Code) sees a stream that errors mid-flight and
// stops. Worse, by the time the error surfaces the upstream was already counted
// as "success" (HTTP 200), so combo / account fallback never got a chance to try
// the next model.
//
// This util reads only the first few KB. If it finds a terminal error event
// before any semantic output (content / tool_call / thinking delta), it reports
// it so the caller can convert the 200 into a retryable non-OK response — which
// is SAFE here precisely because no content byte has reached the client yet.
//
// Mirrors the proven codex.js `_peekSseOverloaded` approach, generalized to the
// OpenAI chat-completion + Claude messages SSE shapes that flow through the
// DefaultExecutor (openai-compatible providers such as vuz).

import { dbg } from "./debugLog.js";
import { STREAM_TTFT_TIMEOUT_MS } from "../config/runtimeConfig.js";

// How many bytes to read before giving up the peek. Enough to cover a role
// delta + an error event; small enough to add negligible latency.
const SSE_PEEK_BYTES = 16 * 1024;

// Substrings (lowercased) marking an empty/no-content upstream completion that
// should be treated as retryable rather than forwarded as a dead stream.
const EMPTY_UPSTREAM_PATTERNS = [
  "empty upstream response",
  "completed with no content",
  "no content (empty",
  "empty or malformed response",
];

// Substrings (lowercased) marking a transient/overloaded upstream worth a retry.
const OVERLOADED_PATTERNS = [
  "overloaded",
  "server_is_overloaded",
  "service_unavailable",
  "service unavailable",
  "try again",
  "temporarily unavailable",
];

function lower(text) {
  return String(text || "").toLowerCase();
}

function matchPattern(text, patterns) {
  const hay = lower(text);
  return patterns.find(p => hay.includes(p)) || null;
}

// Split buffered text into complete SSE blocks (separated by a blank line).
// A trailing partial block (no terminating "\n\n") is dropped so we never parse
// half a JSON payload. CRLF line endings are normalized to LF first — some relays
// emit "\r\n\r\n" block separators, which would otherwise make endsWith("\n\n")
// false and drop the final complete block (missing a lone error-only stream).
function getCompleteSseBlocks(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const parts = normalized.split(/\n\n/);
  if (!normalized.endsWith("\n\n")) parts.pop();
  return parts.filter(Boolean);
}

function parseSseBlock(block) {
  const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "";
  const data = block
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .join("\n");
  return { event, data };
}

// Does this SSE block carry real assistant output (content / tool call / thinking)?
// If yes, the stream is healthy and must be forwarded untouched.
function blockHasSemanticOutput(event, data) {
  if (!data || data === "[DONE]") return false;
  const evt = lower(event);
  // Claude streaming: content deltas, tool_use blocks
  if (evt === "content_block_delta" || evt === "content_block_start") return true;
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  // Claude shapes
  const ctype = parsed?.type;
  if (ctype === "content_block_delta" || ctype === "content_block_start") return true;
  if (parsed?.delta?.text || parsed?.delta?.partial_json || parsed?.delta?.thinking) return true;
  // OpenAI chat.completion.chunk shapes
  const delta = parsed?.choices?.[0]?.delta;
  if (delta) {
    if (typeof delta.content === "string" && delta.content.length > 0) return true;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  }
  // A finish_reason with actual stop also counts as a real (if empty) completion —
  // do NOT treat that as an error, the model legitimately produced nothing more.
  if (parsed?.choices?.[0]?.finish_reason) return true;
  // OpenAI Responses API deltas
  if (typeof ctype === "string" && ctype.startsWith("response.") && ctype.endsWith(".delta")) return true;
  return false;
}

// Extract a flat error string from an SSE error block (OpenAI or Claude shape).
function stringifySseError(data) {
  if (!data || data === "[DONE]") return "";
  try {
    const parsed = JSON.parse(data);
    const error = parsed?.error || parsed?.response?.error || parsed;
    return [error?.message, error?.code, error?.type, error?.reason]
      .filter(Boolean)
      .join(" ");
  } catch {
    return data;
  }
}

// Scan complete blocks for a terminal error that precedes any semantic output.
// Returns { kind, matched } where kind is "empty" | "overloaded" | "error" | null.
function scanForTerminalError(text) {
  for (const block of getCompleteSseBlocks(text)) {
    const { event, data } = parseSseBlock(block);

    // Real output reached the client-bound stream → healthy, stop scanning.
    if (blockHasSemanticOutput(event, data)) {
      return { kind: null, matched: null, sawOutput: true };
    }

    const evt = lower(event);
    let dataType = "";
    try { dataType = lower(JSON.parse(data)?.type); } catch { /* not json */ }

    const isErrorBlock = evt === "error" || dataType === "error" || dataType === "response.failed";
    if (!isErrorBlock) continue;

    const errorText = stringifySseError(data);
    const emptyHit = matchPattern(errorText, EMPTY_UPSTREAM_PATTERNS);
    if (emptyHit) return { kind: "empty", matched: emptyHit, sawOutput: false };

    const overloadedHit = matchPattern(errorText, OVERLOADED_PATTERNS);
    if (overloadedHit) return { kind: "overloaded", matched: overloadedHit, sawOutput: false };

    // Unknown error event before any output — still retryable as a generic upstream error.
    return { kind: "error", matched: errorText.slice(0, 200) || "upstream error", sawOutput: false };
  }
  return { kind: null, matched: null, sawOutput: false };
}

/**
 * Peek the head of a streaming Response body for a pre-content terminal error.
 *
 * Reads up to SSE_PEEK_BYTES from `response.body`, then returns a fresh Response
 * whose body re-emits the consumed bytes followed by the untouched remainder, so
 * the caller can forward it normally when no error is found.
 *
 * @param {Response} response - Upstream streaming response (must be ok + have body)
 * @param {object} [opts]
 * @param {object} [opts.log] - Logger
 * @param {string} [opts.provider] - Provider name (for logging)
 * @param {AbortSignal} [opts.signal] - Upstream request signal; aborting it ends the peek.
 * @param {number} [opts.timeoutMs] - Max time to spend peeking before giving up (defaults
 *   to the TTFT budget). The peek runs BEFORE the pipe-level stall watchdog is armed, so
 *   without its own deadline a 200-then-trickle/stall upstream would hang here forever.
 * @returns {Promise<{ matched: string|null, kind: string|null, response: Response }>}
 *   - matched/kind: non-null when a pre-content terminal error was detected
 *   - response: a replayable Response to use downstream (original body is consumed)
 */
export async function peekStreamForEmptyUpstream(response, { log, provider, signal, timeoutMs = STREAM_TTFT_TIMEOUT_MS } = {}) {
  if (!response || !response.ok || !response.body) {
    return { matched: null, kind: null, response };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  let result = { kind: null, matched: null, sawOutput: false };

  // Deadline so the peek can never outlive the time-to-first-byte budget. Without
  // this, an upstream that sends 200 OK then trickles/stalls the body would block
  // here indefinitely — the pipe stall watchdog is only armed AFTER execute() returns.
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, Math.max(1000, timeoutMs));
  if (deadline.unref) deadline.unref();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (text.length < SSE_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        // Stream ended within the peek window. Flush decoder and do a final scan
        // including any trailing block even without a closing blank line.
        text += decoder.decode();
        result = scanForTerminalError(text.endsWith("\n\n") ? text : text + "\n\n");
        break;
      }
      chunks.push(value);
      text += decoder.decode(value, { stream: true });
      result = scanForTerminalError(text);
      if (result.matched || result.sawOutput) break;
    }
  } catch (e) {
    // A cancel() from the deadline/abort surfaces here as a read rejection — expected.
    dbg("PEEK", `${provider || "?"} | peek read ${timedOut ? "timed out" : "error"}: ${e?.message}`);
  } finally {
    clearTimeout(deadline);
    if (signal) signal.removeEventListener?.("abort", onAbort);
    reader.releaseLock();
  }

  if (result.matched) {
    log?.warn?.("PEEK", `${provider || "upstream"} | pre-content ${result.kind} error: ${result.matched}`);
  }

  // If the peek was aborted/timed out mid-stream, the body is no longer reliably
  // replayable — the deadline/abort handler already called reader.cancel(). Treat as
  // a transient upstream error so the caller can fall back rather than forward a
  // half-dead stream. (Don't touch the released reader here; the stream is cancelled.)
  if (timedOut || signal?.aborted) {
    return { matched: null, kind: null, response: null, aborted: true };
  }

  // Re-assemble a replayable body: already-read chunks first, then the rest.
  // upstreamReader is acquired up-front (not inside start()) so the cancel()
  // handler can always reach it — avoids leaking the upstream connection if the
  // consumer cancels before start() runs.
  const upstreamReader = response.body.getReader();
  const replacementBody = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
    },
    async pull(controller) {
      try {
        const { done, value } = await upstreamReader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) {
      try { upstreamReader.cancel(reason); } catch { /* noop */ }
    },
  });

  const replayed = new Response(replacementBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  return { matched: result.matched, kind: result.kind, response: replayed };
}

export const _internal = {
  SSE_PEEK_BYTES,
  EMPTY_UPSTREAM_PATTERNS,
  OVERLOADED_PATTERNS,
  getCompleteSseBlocks,
  parseSseBlock,
  blockHasSemanticOutput,
  stringifySseError,
  scanForTerminalError,
};
