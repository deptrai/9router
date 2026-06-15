import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

export { COLORS, formatSSE };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

// Build a retryable terminal SSE event for a stream that ended mid-response —
// the upstream socket closed (or was aborted) BEFORE emitting a real finish
// signal (finish_reason / message_stop / [DONE]) even though content had already
// been forwarded. Without this, flush() would emit a benign terminator and the
// client SDK would treat a truncated half-answer as a complete one, silently
// dropping the rest. A recognized error event makes the client throw a clear,
// retryable upstream error instead — so e.g. Claude Code retries the whole turn
// (which then re-enters account/model fallback) rather than stopping mid-sentence.
//
// Mirrors buildAbortTerminator in streamHandler.js (the stall/abort path), but is
// reached on the clean-EOF path where flush() runs and no exception is thrown.
function buildTruncationTerminator(sourceFormat, reason = "upstream stream ended mid-response before completion (truncated)") {
  if (sourceFormat === FORMATS.CLAUDE) {
    const payload = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: reason } });
    return `event: error\ndata: ${payload}\n\n`;
  }
  // OpenAI / OpenAI-compatible: an error chunk the SDK surfaces as a failure
  // (NOT followed by [DONE], which would re-assert a successful completion).
  const payload = JSON.stringify({ error: { message: reason, type: "upstream_error", code: "stream_truncated" } });
  return `data: ${payload}\n\n`;
}

// Does this parsed upstream chunk carry a GENUINE end-of-stream marker? This is
// the single source of truth for the truncation guard, shared by both stream
// modes so they can never drift apart. We read the RAW upstream shape rather
// than translator state (state.finishReason is set inconsistently across
// translators — e.g. Claude→OpenAI leaves it null even on a clean message_stop).
//
// Covered terminal shapes:
//   - OpenAI [DONE] sentinel              → parsed.done
//   - OpenAI chat.completion finish_reason
//   - Claude messages: message_stop / message_delta.stop_reason
//   - OpenAI Responses API: response.completed / response.failed / response.incomplete
//   - Gemini: candidates[].finishReason
//   - Ollama: done:true (already parsed.done)
export function isUpstreamTerminalChunk(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.done) return true;
  if (parsed.type === "message_stop") return true;
  if (parsed.delta?.stop_reason) return true;
  if (parsed.choices?.[0]?.finish_reason) return true;
  if (parsed.candidates?.[0]?.finishReason) return true;
  const t = parsed.type || parsed.event;
  if (t === "response.completed" || t === "response.failed" || t === "response.incomplete") return true;
  // An explicit error event is ALSO a genuine end-of-stream: the upstream
  // terminated (with failure) rather than being cut mid-flight. Treating it as
  // terminal stops flush() from stacking a second truncation terminator on top
  // of the error the client already received. NOTE: this means "ended", not
  // "succeeded" — callers that need success-only semantics (e.g. buffered
  // fallback) must exclude errors separately (see isSuccessfulTerminalChunk).
  if (t === "error") return true;
  return false;
}

// Like isUpstreamTerminalChunk but EXCLUDES error terminals. A stream that
// ended with an error (event: error / response.failed / a bare {error:...}
// chunk) is genuinely finished but did NOT succeed, so a buffered-fallback
// caller must keep trying the next model rather than commit the error as a
// final answer.
export function isSuccessfulTerminalChunk(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  const t = parsed.type || parsed.event;
  if (parsed.error || t === "error" || t === "response.failed") return false;
  return isUpstreamTerminalChunk(parsed);
}

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

function stringifyToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return toolCalls.map((call) => {
    const name = call?.function?.name || call?.name || "unknown";
    const args = call?.function?.arguments || call?.arguments || "";
    return `[tool_call:${name}]${args ? ` ${args}` : ""}`;
  }).join("\n");
}

function extractResponsesOutput(parsed) {
  const eventType = parsed?.type || parsed?.event;
  const data = parsed?.data || parsed;
  if (!eventType || !data) return { content: "", thinking: "" };

  if (eventType === "response.output_text.delta") {
    return { content: data.delta || "", thinking: "" };
  }

  if (eventType === "response.reasoning_summary_text.delta") {
    return { content: "", thinking: data.delta || "" };
  }

  if (eventType === "response.output_item.added" &&
      (data.item?.type === "function_call" || data.item?.type === "custom_tool_call")) {
    return { content: `[tool_call:${data.item.name || "unknown"}]`, thinking: "" };
  }

  if (eventType === "response.function_call_arguments.delta" || eventType === "response.custom_tool_call_input.delta") {
    return { content: data.delta || "", thinking: "" };
  }

  if (eventType === "error" || eventType === "response.failed") {
    const error = data.error || data.response?.error;
    if (error) return { content: `[Error] ${error.message || JSON.stringify(error)}`, thinking: "" };
  }

  return { content: "", thinking: "" };
}

function extractOpenAIOutput(parsed) {
  const delta = parsed?.choices?.[0]?.delta;
  if (!delta) return { content: "", thinking: "" };
  return {
    content: (typeof delta.content === "string" ? delta.content : "") || stringifyToolCalls(delta.tool_calls),
    thinking: typeof delta.reasoning_content === "string" ? delta.reasoning_content : "",
  };
}

function extractClaudeOutput(parsed) {
  const delta = parsed?.delta || {};
  const block = parsed?.content_block || {};
  const toolStart = parsed?.type === "content_block_start" && block.type === "tool_use"
    ? `[tool_call:${block.name || "unknown"}]`
    : "";
  return {
    content: delta.text || delta.partial_json || toolStart || "",
    thinking: delta.thinking || "",
  };
}

function appendOutput(output, addContent, addThinking) {
  const content = typeof addContent === "string" ? addContent : "";
  const thinking = typeof addThinking === "string" ? addThinking : "";
  if (content) {
    output.totalContentLength += content.length;
    output.accumulatedContent += content;
  }
  if (thinking) {
    output.totalContentLength += thinking.length;
    output.accumulatedThinking += thinking;
  }
}

function extractOutputForFormat(parsed, format) {
  if (format === FORMATS.OPENAI_RESPONSES) return extractResponsesOutput(parsed);
  if (format === FORMATS.OPENAI) return extractOpenAIOutput(parsed);
  if (format === FORMATS.CLAUDE) return extractClaudeOutput(parsed);
  return { content: "", thinking: "" };
}

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    billingSource = undefined
  } = options;

  let buffer = "";
  let usage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE ? { ...initState(sourceFormat), provider, toolNameMap, model } : null;

  const outputState = {
    totalContentLength: 0,
    accumulatedContent: "",
    accumulatedThinking: "",
  };
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};
  // Did the UPSTREAM emit a genuine end-of-stream signal (finish_reason / [DONE]
  // sentinel / Claude message_stop)? Distinguishes a real completion from a socket
  // that closed mid-response. In TRANSLATE mode state.finishReason already captures
  // this; in PASSTHROUGH mode we track it here. flush() uses this to decide between
  // a benign terminator and a retryable truncation error.
  let upstreamFinished = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;

          // Drop the upstream [DONE] sentinel here — flush() always emits exactly
          // one terminator at stream end. Forwarding it too produces a double
          // "data: [DONE]" which can confuse strict client SDKs.
          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]") {
            upstreamFinished = true; // upstream signalled a real end-of-stream
            continue;
          }

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());

              const idFixed = fixInvalidId(parsed);

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Mark a genuine upstream end-of-stream from the RAW bytes BEFORE
              // the hasValuableContent() skip below — terminal markers like the
              // Responses API "response.completed" carry no "valuable content"
              // and would otherwise be dropped, leaving upstreamFinished false on
              // a healthy tool-call-only / reasoning-only stream.
              if (isUpstreamTerminalChunk(parsed)) upstreamFinished = true;

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              const passthroughFormat = parsed.type?.startsWith?.("response.") ? FORMATS.OPENAI_RESPONSES : FORMATS.OPENAI;
              const outputParts = extractOutputForFormat(parsed, passthroughFormat);
              appendOutput(outputState, outputParts.content, outputParts.thinking);

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = extracted;
              }

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk) upstreamFinished = true;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, outputState.totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch { }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        // The bare [DONE] sentinel is not valid JSON, so parseSSELine() returns
        // null and the line is dropped before the terminal-marker check below.
        // Catch it explicitly so a stream whose ONLY end signal is [DONE] (a
        // non-standard provider that omits finish_reason/message_stop) still
        // marks upstreamFinished — otherwise flush()'s truncation guard would
        // false-positive and emit a spurious retryable error. Mirrors the
        // passthrough-mode [DONE] handling so the two modes stay in lockstep.
        if (trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]") {
          upstreamFinished = true;
          continue;
        }

        try {
        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;

        // Mark a genuine upstream end-of-stream from the RAW bytes, before any
        // translator state mutation. This is the truncation guard's source of
        // truth: state.finishReason is set inconsistently across translators
        // (e.g. Claude→OpenAI leaves it null even on a clean message_stop), so
        // relying on it would false-positive and corrupt healthy streams. Uses
        // the SAME detector as passthrough so the two modes never drift apart.
        if (isUpstreamTerminalChunk(parsed)) upstreamFinished = true;

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the upstream [DONE] sentinel — drop it here.
        // flush() emits exactly one terminator at stream end; forwarding the upstream
        // sentinel too produces a double "data: [DONE]" which can confuse strict SDKs.
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          continue;
        }

        if (targetFormat === FORMATS.OPENAI_RESPONSES) {
          const outputParts = extractOutputForFormat(parsed, targetFormat);
          appendOutput(outputState, outputParts.content, outputParts.thinking);
        } else {
          // Claude format - content
          if (parsed.delta?.text) {
            outputState.totalContentLength += parsed.delta.text.length;
            outputState.accumulatedContent += parsed.delta.text;
          }
          // Claude format - thinking
          if (parsed.delta?.thinking) {
            outputState.totalContentLength += parsed.delta.thinking.length;
            outputState.accumulatedThinking += parsed.delta.thinking;
          }

          // Claude format - tool-call output (input_json_delta args + tool_use
          // start). These carry NO delta.text but ARE genuine semantic output.
          // Without counting them, a truncated tool-call-only stream leaves
          // totalContentLength at 0 and flush()'s truncation guard never fires
          // (P1) — the client silently accepts a half-emitted tool call as
          // complete. Count length toward the guard's "did we emit output?"
          // signal only; do NOT append to accumulatedContent (which tracks the
          // textual answer for logging/usage).
          if (typeof parsed.delta?.partial_json === "string") {
            outputState.totalContentLength += parsed.delta.partial_json.length;
          } else if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
            outputState.totalContentLength += (parsed.content_block?.name || "tool_call").length;
          }

          // OpenAI format - content/tool calls
          if (parsed.choices?.[0]?.delta) {
            const outputParts = extractOutputForFormat(parsed, FORMATS.OPENAI);
            appendOutput(outputState, outputParts.content, outputParts.thinking);
          }
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              outputState.totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                outputState.accumulatedThinking += part.text;
              } else {
                outputState.accumulatedContent += part.text;
              }
            } else if (part.functionCall) {
              // Gemini tool-call part: genuine semantic output with no .text.
              // Count it toward the truncation guard (P1) so a truncated
              // tool-call-only Gemini stream is not mistaken for empty.
              outputState.totalContentLength += (part.functionCall.name || "tool_call").length;
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = extracted; // Keep original usage for logging

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && outputState.totalContentLength > 0) {
              const estimated = estimateUsage(body, outputState.totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }
        }
        } catch (err) {
          // A single malformed/unexpected chunk must not kill the whole stream.
          // Skip it and keep translating; flush() still emits the terminator.
          dbg("SSE", `transform line error (skipped): ${err?.message}`);
        }
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      // Track whether we already emitted a terminator to the client. If the
      // try block emits [DONE] and then a LATER step (logUsage, appendRequestLog,
      // onStreamComplete) throws, the catch must NOT emit a second terminator —
      // a double [DONE] or a trailing error event after a successful end can
      // confuse the client SDK.
      let terminatorEmitted = false;
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          if (!hasValidUsage(usage) && outputState.totalContentLength > 0) {
            usage = estimateUsage(body, outputState.totalContentLength, FORMATS.OPENAI);
          }

          if (hasValidUsage(usage)) {
            logUsage(provider, usage, model, connectionId, apiKey, billingSource);
          } else {
            appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
          }
          
          // Truncation guard: content was forwarded but the upstream socket
          // closed BEFORE any real finish signal ([DONE] / finish_reason). Emit a
          // retryable error event instead of the benign [DONE] sentinel, so the
          // client treats a half-answer as a failure (and retries the turn) rather
          // than silently accepting a truncated response as complete.
          if (outputState.totalContentLength > 0 && !upstreamFinished) {
            const term = buildTruncationTerminator(sourceFormat);
            reqLogger?.appendConvertedChunk?.(term);
            controller.enqueue(sharedEncoder.encode(term));
            terminatorEmitted = true;
            dbg("SSE", `truncation detected (passthrough) | bytes=${outputState.totalContentLength} | no upstream finish → retryable error terminator`);
            if (onStreamComplete) {
              onStreamComplete({
                content: outputState.accumulatedContent,
                thinking: outputState.accumulatedThinking
              }, usage, ttftAt);
            }
            return;
          }

          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          terminatorEmitted = true;

          if (onStreamComplete) {
            onStreamComplete({
              content: outputState.accumulatedContent,
              thinking: outputState.accumulatedThinking
            }, usage, ttftAt);
          }
          return;
        }

        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed && !parsed.done) {
            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Truncation guard (translate mode): real output was emitted but the
        // upstream never sent a finish signal. We rely ONLY on upstreamFinished,
        // which is set in transform() the instant a genuine terminal marker is
        // seen in the RAW upstream bytes (message_stop / [DONE] / finish_reason /
        // stop_reason) — NOT on state.finishReason, which the translator may leave
        // null even on a healthy stream. A closed socket mid-response leaves
        // upstreamFinished false, so we surface a retryable error terminator
        // instead of [DONE] and the client retries rather than accepting a
        // truncated answer as complete.
        if (outputState.totalContentLength > 0 && !upstreamFinished) {
          const term = buildTruncationTerminator(sourceFormat);
          reqLogger?.appendConvertedChunk?.(term);
          controller.enqueue(sharedEncoder.encode(term));
          terminatorEmitted = true;
          dbg("SSE", `truncation detected (translate) | bytes=${outputState.totalContentLength} | no upstream finish → retryable error terminator`);
          if (onStreamComplete) {
            onStreamComplete({
              content: outputState.accumulatedContent,
              thinking: outputState.accumulatedThinking
            }, state?.usage, ttftAt);
          }
          return;
        }

        const doneOutput = "data: [DONE]\n\n";
        reqLogger?.appendConvertedChunk?.(doneOutput);
        controller.enqueue(sharedEncoder.encode(doneOutput));
        terminatorEmitted = true;

        if (!hasValidUsage(state?.usage) && outputState.totalContentLength > 0) {
          state.usage = estimateUsage(body, outputState.totalContentLength, sourceFormat);
        }

        if (hasValidUsage(state?.usage)) {
          logUsage(state.provider || targetFormat, state.usage, model, connectionId, apiKey, billingSource);
        } else {
          appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
        }
        
        if (onStreamComplete) {
          onStreamComplete({
            content: outputState.accumulatedContent,
            thinking: outputState.accumulatedThinking
          }, state?.usage, ttftAt);
        }
      } catch (error) {
        console.log("Error in flush:", error);
        // Even on failure we must terminate the SSE stream, otherwise the client
        // sees a 200 whose body just stops ("empty or malformed response").
        // Skip if a terminator was already emitted before the throw — emitting
        // a second [DONE] or a trailing error event can corrupt the client SDK
        // state machine after a successful end.
        if (!terminatorEmitted) {
          try {
            const doneOutput = mode === STREAM_MODE.PASSTHROUGH || sourceFormat !== FORMATS.CLAUDE
              ? "data: [DONE]\n\n"
              : `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "stream finalization failed" } })}\n\n`;
            controller.enqueue(sharedEncoder.encode(doneOutput));
          } catch (e) { /* controller already closed */ }
        }
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, billingSource = undefined) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    billingSource
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, billingSource = undefined) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    billingSource
  });
}
