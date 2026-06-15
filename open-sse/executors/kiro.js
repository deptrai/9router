import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { v4 as uuidv4 } from "uuid";
import { refreshKiroToken } from "../services/tokenRefresh.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry } from "../config/runtimeConfig.js";

/**
 * KiroExecutor - Executor for Kiro AI (AWS CodeWhisperer)
 * Uses AWS CodeWhisperer streaming API with AWS EventStream binary format
 */
export class KiroExecutor extends BaseExecutor {
  constructor() {
    super("kiro", PROVIDERS.kiro);
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      ...this.config.headers,
      "Amz-Sdk-Request": "attempt=1; max=3",
      "Amz-Sdk-Invocation-Id": uuidv4()
    };

    if (credentials.accessToken) {
      headers["Authorization"] = `Bearer ${credentials.accessToken}`;
    }

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    return body;
  }

  /**
   * Custom execute for Kiro - handles AWS EventStream binary response with retry support
   */
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl(model, stream, 0);
    const transformedBody = this.transformRequest(model, body, stream, credentials);
    
    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    let retryAttempts = 0;

    while (true) {
      const headers = this.buildHeaders(credentials, stream);
      
      const response = await proxyAwareFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(transformedBody),
        signal
      }, proxyOptions);

      // Check if should retry based on status code
      const { attempts: maxRetries, delayMs } = resolveRetryEntry(retryConfig[response.status]);
      if (!response.ok && maxRetries > 0 && retryAttempts < maxRetries) {
        retryAttempts++;
        log?.debug?.("RETRY", `${response.status} retry ${retryAttempts}/${maxRetries} after ${delayMs / 1000}s`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      if (!response.ok) {
        return { response, url, headers, transformedBody };
      }

      // Success - transform and return
      // For Kiro, we need to transform the binary EventStream to SSE
      // Create a TransformStream to convert binary to SSE text
      const transformedResponse = this.transformEventStreamToSSE(response, model);
      return { response: transformedResponse, url, headers, transformedBody };
    }
  }

  /**
   * Transform AWS EventStream binary response to SSE text stream
   * Using TransformStream instead of ReadableStream.pull() to avoid Workers timeout
   */
  transformEventStreamToSSE(response, model) {
    let buffer = new Uint8Array(0);
    let chunkIndex = 0;
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const state = {
      endDetected: false,
      finishEmitted: false,
      usageEmitted: false,      // guards against emitting usage multiple times
      hasToolCalls: false,
      hasReasoningContent: false,
      reasoningChunkCount: 0,
      toolCallIndex: 0,
      seenToolIds: new Map()
    };

    /**
     * Compute usage from state. Uses metricsEvent exact tokens when available;
     * falls back to estimating from totalContentLength + contextUsagePercentage.
     */
    function computeUsage(st) {
      if (st.usage) return st.usage;
      const estimatedOutputTokens = (st.totalContentLength || 0) > 0
        ? Math.max(1, Math.floor(st.totalContentLength / 4))
        : 0;
      const estimatedInputTokens = (st.contextUsagePercentage || 0) > 0
        ? Math.floor(st.contextUsagePercentage * 200000 / 100)
        : 0;
      return {
        prompt_tokens: estimatedInputTokens,
        completion_tokens: estimatedOutputTokens,
        total_tokens: estimatedInputTokens + estimatedOutputTokens
      };
    }

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        // Append to buffer
        const newBuffer = new Uint8Array(buffer.length + chunk.length);
        newBuffer.set(buffer);
        newBuffer.set(chunk, buffer.length);
        buffer = newBuffer;

        // Parse events from buffer
        let iterations = 0;
        const maxIterations = 1000;
        while (buffer.length >= 16 && iterations < maxIterations) {
          iterations++;
          const view = new DataView(buffer.buffer, buffer.byteOffset);
          const totalLength = view.getUint32(0, false);

          if (totalLength < 16 || totalLength > buffer.length || buffer.length < totalLength) break;

          const eventData = buffer.slice(0, totalLength);
          buffer = buffer.slice(totalLength);

          const event = parseEventFrame(eventData);
          if (!event) continue;

          const eventType = event.headers[":event-type"] || "";
          
          // Track total content length for token estimation
          if (!state.totalContentLength) state.totalContentLength = 0;
          if (!state.contextUsagePercentage) state.contextUsagePercentage = 0;

          // Handle assistantResponseEvent
          if (eventType === "assistantResponseEvent" && event.payload?.content) {
            const content = event.payload.content;
            state.totalContentLength += content.length;
            
            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: chunkIndex === 0
                  ? { role: "assistant", content }
                  : { content },
                finish_reason: null
              }]
            };
            chunkIndex++;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle reasoningContentEvent (Kiro thinking / reasoning)
          // Kiro returns reasoning as a separate event when the request system
          // prompt contains <thinking_mode>enabled</thinking_mode>. Surface it
          // as OpenAI delta.reasoning_content so downstream translators can map
          // it back to Claude thinking blocks / Anthropic reasoning, etc.
          if (eventType === "reasoningContentEvent") {
            const reasoning = event.payload?.reasoningContentEvent || event.payload || {};
            const reasoningText = (typeof reasoning === "string")
              ? reasoning
              : (reasoning.text || reasoning.content || "");
            if (reasoningText) {
              state.hasReasoningContent = true;
              state.totalContentLength += reasoningText.length;

              const reasoningDelta = state.reasoningChunkCount === 0 && chunkIndex === 0
                ? { role: "assistant", reasoning_content: reasoningText }
                : { reasoning_content: reasoningText };

              const chunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: reasoningDelta,
                  finish_reason: null
                }]
              };
              chunkIndex++;
              state.reasoningChunkCount++;
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          }

          // Handle codeEvent
          if (eventType === "codeEvent" && event.payload?.content) {
            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: { content: event.payload.content },
                finish_reason: null
              }]
            };
            chunkIndex++;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle toolUseEvent
          if (eventType === "toolUseEvent" && event.payload) {
            state.hasToolCalls = true;
            const toolUse = event.payload;
            const toolUses = Array.isArray(toolUse) ? toolUse : [toolUse];

            for (const singleToolUse of toolUses) {
              const toolCallId = singleToolUse.toolUseId || `call_${Date.now()}`;
              const toolName = singleToolUse.name || "";
              const toolInput = singleToolUse.input;

              let toolIndex;
              const isNewTool = !state.seenToolIds.has(toolCallId);

              if (isNewTool) {
                toolIndex = state.toolCallIndex++;
                state.seenToolIds.set(toolCallId, toolIndex);

                const startChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      ...(chunkIndex === 0 ? { role: "assistant" } : {}),
                      tool_calls: [{
                        index: toolIndex,
                        id: toolCallId,
                        type: "function",
                        function: {
                          name: toolName,
                          arguments: ""
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                chunkIndex++;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(startChunk)}\n\n`));
              } else {
                toolIndex = state.seenToolIds.get(toolCallId);
              }

              if (toolInput !== undefined) {
                let argumentsStr;

                if (typeof toolInput === 'string') {
                  argumentsStr = toolInput;
                } else if (typeof toolInput === 'object') {
                  argumentsStr = JSON.stringify(toolInput);
                } else {
                  continue;
                }

                // Count tool arguments towards output token estimate.
                // metricsEvent (exact tokens) takes priority when available; this
                // ensures the estimate is non-zero for pure tool-call responses.
                state.totalContentLength += argumentsStr.length;

                const argsChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolIndex,
                        function: {
                          arguments: argumentsStr
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                chunkIndex++;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(argsChunk)}\n\n`));
              }
            }
          }

          // Handle messageStopEvent
          if (eventType === "messageStopEvent") {
            // If the metering+context branch already emitted the finish chunk,
            // skip — we only need one finish chunk.
            if (!state.finishEmitted) {
              // Compute and attach usage to the stop chunk so it is always present,
              // regardless of whether meteringEvent/contextUsageEvent arrived first.
              // This prevents the race where messageStopEvent fires before metering
              // events, leaving parseSSEToOpenAIResponse with no usage chunk.
              if (!state.usageEmitted) {
                state.usageEmitted = true;
                state.usage = state.usage || computeUsage(state);
              }
              const chunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: state.hasToolCalls ? "tool_calls" : "stop"
                }],
                ...(state.usage && { usage: state.usage })
              };
              state.finishEmitted = true;
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          }

          // Handle contextUsageEvent to extract contextUsagePercentage
          if (eventType === "contextUsageEvent" && event.payload?.contextUsagePercentage) {
            state.contextUsagePercentage = event.payload.contextUsagePercentage;
            // Mark that we received context usage event
            state.hasContextUsage = true;
          }

          // Handle meteringEvent - mark that we received it
          if (eventType === "meteringEvent") {
            state.hasMeteringEvent = true;
          }

          // Handle metricsEvent for token usage
          if (eventType === "metricsEvent") {
            // Extract usage data from metricsEvent payload
            const metrics = event.payload?.metricsEvent || event.payload;
            if (metrics && typeof metrics === 'object') {
              const inputTokens = metrics.inputTokens || 0;
              const outputTokens = metrics.outputTokens || 0;
              
              if (inputTokens > 0 || outputTokens > 0) {
                state.usage = {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens
                };
              }
            }
          }

          // Emit final chunk only after receiving BOTH meteringEvent AND contextUsageEvent
          // (only fires if messageStopEvent hasn't already emitted a finish chunk with usage)
          if (state.hasMeteringEvent && state.hasContextUsage && !state.finishEmitted) {
            state.finishEmitted = true;
            state.usageEmitted = true;

            // Estimate tokens if not available from events
            if (!state.usage) {
              state.usage = computeUsage(state);
            }
            
            const finishChunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: state.hasToolCalls ? "tool_calls" : "stop"
              }]
            };
            
            // Include usage in final chunk if available
            if (state.usage) {
              finishChunk.usage = state.usage;
            }
            
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
          }
          // Late metering: messageStopEvent already emitted but usage wasn't known yet.
          // Emit a standalone usage chunk so downstream parsers can pick it up.
          if (state.finishEmitted && !state.usageEmitted && state.hasMeteringEvent && state.hasContextUsage) {
            state.usageEmitted = true;
            if (!state.usage) state.usage = computeUsage(state);
            if (state.usage) {
              const usageChunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: null }],
                usage: state.usage
              };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
            }
          }
        }

        if (iterations >= maxIterations) {
          console.warn("[Kiro] Max iterations reached in event parsing");
        }
      },

      flush(controller) {
        // A genuine end-of-turn sets finishEmitted mid-stream — it is only set
        // true when a real terminal arrived (messageStopEvent, or the
        // meteringEvent+contextUsageEvent pair). Reaching flush() with it still
        // false means the upstream AWS EventStream closed WITHOUT signalling
        // completion.
        if (!state.finishEmitted) {
          // Truncation guard (Fix #2): real content was already emitted to the
          // client but the upstream died before any stop event. Do NOT fabricate
          // a finish_reason:stop chunk + [DONE] here — that terminal marker would
          // tell the downstream SSE layer (stream.js) the turn completed normally,
          // so its truncation guard (Fix #1) would NOT fire and the client (Claude
          // Code) would silently accept a half-answer as complete, stopping
          // mid-sentence. Instead close the stream WITHOUT a terminal marker:
          // stream.js then sees content-but-no-finish and emits a retryable error
          // terminator, so the client retries the whole turn (re-entering
          // account/model fallback) rather than truncating.
          if (chunkIndex > 0) {
            return; // no fabricated finish, no [DONE] — let stream.js surface it
          }

          // No content at all (empty upstream). Preserve the existing behaviour:
          // emit a finish + [DONE] so non-truncation paths are unchanged. The
          // empty-upstream→retry case is handled separately (ssePeek on relay
          // providers); a pure-kiro empty stream still terminates cleanly here.
          state.finishEmitted = true;
          if (!state.usageEmitted) {
            state.usageEmitted = true;
            if (!state.usage) state.usage = computeUsage(state);
          }
          const finishChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: state.hasToolCalls ? "tool_calls" : "stop"
            }],
            ...(state.usage && { usage: state.usage })
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
        }

        // Send final done message
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      }
    });

    // Pipe response body through transform stream
    if (!response.body) {
      return new Response("data: [DONE]\n\n", { status: response.status, headers: { "Content-Type": "text/event-stream" } });
    }
    const transformedStream = response.body.pipeThrough(transformStream);

    return new Response(transformedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    try {
      // Use centralized refreshKiroToken function (handles both AWS SSO OIDC and Social Auth)
      const result = await refreshKiroToken(
        credentials.refreshToken,
        credentials.providerSpecificData,
        log,
        proxyOptions
      );

      return result;
    } catch (error) {
      log?.error?.("TOKEN", `Kiro refresh error: ${error.message}`);
      return null;
    }
  }
}

/**
 * Parse AWS EventStream frame
 */
function parseEventFrame(data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset);
    const headersLength = view.getUint32(4, false);

    // Parse headers
    const headers = {};
    let offset = 12; // After prelude
    const headerEnd = 12 + headersLength;

    while (offset < headerEnd && offset < data.length) {
      const nameLen = data[offset];
      offset++;
      if (offset + nameLen > data.length) break;

      const name = new TextDecoder().decode(data.slice(offset, offset + nameLen));
      offset += nameLen;

      const headerType = data[offset];
      offset++;

      if (headerType === 7) { // String type
        const valueLen = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        if (offset + valueLen > data.length) break;

        const value = new TextDecoder().decode(data.slice(offset, offset + valueLen));
        offset += valueLen;
        headers[name] = value;
      } else {
        break;
      }
    }

    // Parse payload
    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4; // Exclude message CRC

    let payload = null;
    if (payloadEnd > payloadStart) {
      const payloadStr = new TextDecoder().decode(data.slice(payloadStart, payloadEnd));

      // Skip empty or whitespace-only payloads
      if (!payloadStr || !payloadStr.trim()) {
        return { headers, payload: null };
      }

      try {
        payload = JSON.parse(payloadStr);
      } catch (parseError) {
        // Log parse error for debugging
        console.warn(`[Kiro] Failed to parse payload: ${parseError.message} | payload: ${payloadStr.substring(0, 100)}`);
        payload = { raw: payloadStr };
      }
    }

    return { headers, payload };
  } catch {
    return null;
  }
}

export default KiroExecutor;
