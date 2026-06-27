import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { addBufferToUsage, filterUsageForFormat } from "../../utils/usageTracking.js";
import { createErrorResult } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";

// Find end index of a JSON object starting with { — brace matching with
// string/escape awareness. Returns index after closing }, or -1 if incomplete.
function findJsonEnd(text) {
  if (!text.startsWith("{")) return -1;
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Tool-call format constants — must match openai-to-claude.js
const TC_OPEN = "<tool_call>";
const TC_CLOSE = "antml:invoke";

// Legacy format constants — GLM-5.2 non-deterministically emits these
// instead of the XML-tagged format, even with new instructions.
const LEGACY_OPEN = "[TOOL_CALLS]";
const LEGACY_MID = ["[ARGS]", "[TOOL_CALLS]"];

// Try to parse a legacy [TOOL_CALLS]...{json} block from buf.
// GLM-5.2 emits multiple non-deterministic variants — see openai-to-claude.js
// for full documentation. Generalized strategy: find first { after [TOOL_CALLS],
// brace-match JSON, extract name+arguments from JSON or text before {.
// Returns { name, argsJson, remainder, openIdx } on success, null otherwise.
function tryParseLegacyToolCall(buf) {
  const openIdx = buf.indexOf(LEGACY_OPEN);
  if (openIdx === -1) return null;
  const afterOpen = buf.slice(openIdx + LEGACY_OPEN.length);
  const braceStart = afterOpen.indexOf("{");
  if (braceStart === -1) return null;
  const jsonEnd = findJsonEnd(afterOpen.slice(braceStart));
  if (jsonEnd === -1) return null;
  const body = afterOpen.slice(braceStart, braceStart + jsonEnd).trim();
  const remainder = afterOpen.slice(braceStart + jsonEnd);
  let cleanRemainder = remainder;
  if (cleanRemainder.startsWith(")")) cleanRemainder = cleanRemainder.slice(1);
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  let name = null, args = {};
  if (typeof parsed.name === "string" && parsed.arguments !== undefined) {
    name = parsed.name;
    args = parsed.arguments;
  } else {
    const textBefore = afterOpen.slice(0, braceStart);
    let candidate = textBefore;
    for (const m of LEGACY_MID) candidate = candidate.split(m)[0];
    candidate = candidate.replace(/[()]/g, "").trim();
    if (candidate) { name = candidate; args = parsed; }
  }
  if (!name) return null;
  const argsJson = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return { name, argsJson, remainder: cleanRemainder, openIdx };
}

/**
 * Convert OpenAI ChatCompletion response to Anthropic Messages format.
 * Handles both native tool_calls and inline text-encoded tool calls
 * (XML-tagged JSON format used by Windsurf executor).
 */
function openaiToClaudeNonStreaming(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;

  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  // Parse inline tool calls from text content (Windsurf format)
  let textContent = typeof message.content === "string" ? message.content : "";

  if (textContent) {
    // Extract tool-call blocks from text
    let remaining = textContent;
    while (true) {
      // ── Legacy format check: [TOOL_CALLS]name[ARGS]{json} ──
      // GLM-5.2 non-deterministically emits this even with new instructions.
      const legacyOpenIdx = remaining.indexOf(LEGACY_OPEN);
      const newOpenIdx = remaining.indexOf(TC_OPEN);
      // If legacy marker appears and (no new marker OR legacy comes first)
      if (legacyOpenIdx !== -1 && (newOpenIdx === -1 || legacyOpenIdx < newOpenIdx)) {
        const legacy = tryParseLegacyToolCall(remaining);
        if (legacy && legacy.name) {
          // Emit text before the legacy open tag
          if (legacy.openIdx > 0) {
            const before = remaining.slice(0, legacy.openIdx).trim();
            if (before) content.push({ type: "text", text: before });
          }
          content.push({
            type: "tool_use",
            id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: legacy.name,
            input: typeof legacy.argsJson === "string" ? JSON.parse(legacy.argsJson) : legacy.argsJson,
          });
          remaining = legacy.remainder;
          continue;
        }
        // Legacy parse failed (not incomplete since non-streaming has full text)
        // → fall through to new-format check
      }

      const openIdx = newOpenIdx;
      if (openIdx === -1) {
        // No more tool calls — emit remaining text
        const cleaned = remaining.trim();
        if (cleaned) content.push({ type: "text", text: cleaned });
        break;
      }
      // Emit text before tool call
      if (openIdx > 0) {
        const before = remaining.slice(0, openIdx).trim();
        if (before) content.push({ type: "text", text: before });
      }
      const afterOpen = remaining.slice(openIdx + TC_OPEN.length);
      // Skip whitespace between open tag and JSON body
      const wsMatch = afterOpen.match(/^\s*/);
      const wsLen = wsMatch ? wsMatch[0].length : 0;
      const afterWs = afterOpen.slice(wsLen);
      const closeIdx = afterWs.indexOf(TC_CLOSE);
      let body, afterClose;
      if (closeIdx === -1) {
        // No close tag — some models (Sonnet) emit open tag + JSON without
        // close tag. Try to parse JSON by brace matching from the first {.
        const braceStart = afterWs.indexOf("{");
        if (braceStart >= 0) {
          const jsonEnd = findJsonEnd(afterWs.slice(braceStart));
          if (jsonEnd > 0) {
            body = afterWs.slice(braceStart, braceStart + jsonEnd).trim();
            afterClose = afterWs.slice(braceStart + jsonEnd);
          }
        }
        if (!body) {
          // Can't parse — emit as text
          content.push({ type: "text", text: TC_OPEN + afterOpen });
          break;
        }
      } else {
        body = afterWs.slice(0, closeIdx).trim();
        afterClose = afterWs.slice(closeIdx + TC_CLOSE.length);
      }
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.name === "string") {
          content.push({
            type: "tool_use",
            id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: parsed.name,
            input: parsed.arguments || {},
          });
        } else {
          content.push({ type: "text", text: TC_OPEN + body + TC_CLOSE });
        }
      } catch {
        content.push({ type: "text", text: TC_OPEN + body + TC_CLOSE });
      }
      remaining = afterClose;
    }
  }

  // Handle native OpenAI tool_calls
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.function?.name || "unknown",
        input,
      });
    }
  }

  // Ensure at least empty content
  if (content.length === 0) content.push({ type: "text", text: "" });

  // Map finish_reason → stop_reason
  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  // If we found inline tool calls but finish_reason is "stop", override
  if (stopReason === "end_turn" && content.some(b => b.type === "tool_use")) {
    stopReason = "tool_use";
  }

  const usage = responseBody.usage || {};
  return {
    id: responseBody.id?.replace("chatcmpl-", "msg_") || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: responseBody.model || "unknown",
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

/**
 * Translate non-streaming response body from provider format → OpenAI format.
 */
export function translateNonStreamingResponse(responseBody, targetFormat, sourceFormat) {
  if (targetFormat === sourceFormat) return responseBody;

  // Client requested Claude format (/v1/messages) but provider returns OpenAI
  // ChatCompletion format (e.g. Windsurf executor returns OpenAI-shaped JSON).
  // Translate to Anthropic Messages format so the client gets proper response.
  // Windsurf has format="windsurf" but its executor returns OpenAI ChatCompletion,
  // so we check sourceFormat (client) === claude and treat windsurf target as openai.
  if (sourceFormat === FORMATS.CLAUDE && targetFormat !== FORMATS.CLAUDE) {
    return openaiToClaudeNonStreaming(responseBody);
  }

  if (targetFormat === FORMATS.OPENAI) return responseBody;

  // Gemini / Antigravity
  if (targetFormat === FORMATS.GEMINI || targetFormat === FORMATS.ANTIGRAVITY || targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.VERTEX) {
    const response = responseBody.response || responseBody;
    if (!response?.candidates?.[0]) return responseBody;

    const candidate = response.candidates[0];
    const content = candidate.content;
    const usage = response.usageMetadata || responseBody.usageMetadata;
    let textContent = "", reasoningContent = "";
    const toolCalls = [];

    if (content?.parts) {
      for (const part of content.parts) {
        if (part.thought === true && part.text) reasoningContent += part.text;
        else if (part.text !== undefined) textContent += part.text;
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${part.functionCall.name}_${Date.now()}_${toolCalls.length}`,
            type: "function",
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }
          });
        }
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = (candidate.finishReason || "stop").toLowerCase();
    if (finishReason === "stop" && toolCalls.length > 0) finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${response.responseId || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
      model: response.modelVersion || "gemini",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (usage) {
      result.usage = {
        prompt_tokens: (usage.promptTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      };
      if (usage.thoughtsTokenCount > 0) {
        result.usage.completion_tokens_details = { reasoning_tokens: usage.thoughtsTokenCount };
      }
    }
    return result;
  }

  // Claude
  if (targetFormat === FORMATS.CLAUDE) {
    if (!responseBody.content) return responseBody;

    let textContent = "", thinkingContent = "";
    const toolCalls = [];

    for (const block of responseBody.content) {
      if (block.type === "text") {
        // Strip markdown code block markers (e.g. kimi wraps JSON in ```json...```)
        const raw = block.text ?? "";
        const text = raw.replace(/^\s*```\s*json\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
        textContent += text;
      } else if (block.type === "thinking") thinkingContent += block.thinking || "";
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (thinkingContent) message.reasoning_content = thinkingContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = responseBody.stop_reason || "stop";
    if (finishReason === "end_turn") finishReason = "stop";
    if (finishReason === "tool_use") finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${responseBody.id || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseBody.model || "claude",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (responseBody.usage) {
      result.usage = {
        prompt_tokens: responseBody.usage.input_tokens || 0,
        completion_tokens: responseBody.usage.output_tokens || 0,
        total_tokens: (responseBody.usage.input_tokens || 0) + (responseBody.usage.output_tokens || 0)
      };
    }
    return result;
  }

  // Ollama
  if (targetFormat === FORMATS.OLLAMA) {
    return ollamaBodyToOpenAI(responseBody);
  }

  return responseBody;
}

/**
 * Handle non-streaming response from provider.
 */
export async function handleNonStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, billingSource, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, trackDone, appendLog }) {
  trackDone();
  const contentType = providerResponse.headers.get("content-type") || "";
  let responseBody;

  if (contentType.includes("text/event-stream")) {
    const sseText = await providerResponse.text();
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    }
    responseBody = parsed;
  } else {
    try {
      responseBody = await providerResponse.json();
    } catch (err) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      console.error(`[ChatCore] Failed to parse JSON from ${provider}:`, err.message);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
    }
  }

  reqLogger.logProviderResponse(providerResponse.status, providerResponse.statusText, providerResponse.headers, responseBody);
  if (onRequestSuccess) await onRequestSuccess();

  // Decloak tool_use names once on raw Claude body, before any translation (INPUT side)
  responseBody = decloakToolNames(responseBody, toolNameMap);

  const usage = extractUsageFromResponse(responseBody);
  appendLog({ tokens: usage, status: "200 OK" });
  saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, billingSource });

  const translatedResponse = needsTranslation(targetFormat, sourceFormat)
    ? translateNonStreamingResponse(responseBody, targetFormat, sourceFormat)
    : responseBody;

  // When the response is in Claude/Anthropic format (client requested /v1/messages),
  // skip OpenAI-specific fixups — the translated response has content blocks,
  // stop_reason, and usage in Anthropic format already.
  const isClaudeFormat = sourceFormat === FORMATS.CLAUDE &&
    translatedResponse?.type === "message" && Array.isArray(translatedResponse?.content);

  if (!isClaudeFormat) {
    // Fix finish_reason for tool_calls: some providers return non-standard values (e.g. "other")
    if (translatedResponse?.choices?.[0]) {
      const choice = translatedResponse.choices[0];
      const msg = choice.message;
      const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
      if (hasToolCalls && choice.finish_reason !== "tool_calls") {
        choice.finish_reason = "tool_calls";
      }
    }

    // Ensure OpenAI-required fields
    if (!translatedResponse.object) translatedResponse.object = "chat.completion";
    if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);

    // Strip Azure-specific fields
    delete translatedResponse.prompt_filter_results;
    if (translatedResponse?.choices) {
      for (const choice of translatedResponse.choices) delete choice.content_filter_results;
    }

    if (translatedResponse?.usage) {
      translatedResponse.usage = filterUsageForFormat(addBufferToUsage(translatedResponse.usage), sourceFormat);
    }

    // Strip reasoning_content — some clients (e.g. Firecrawl AI SDK) have JSON parsers that
    // break on this non-standard field, even though OpenAI allows it in extensions.
    if (translatedResponse?.choices) {
      for (const choice of translatedResponse.choices) {
        if (choice?.message) delete choice.message.reasoning_content;
      }
    }
  }

  reqLogger.logConvertedResponse(translatedResponse);

  const totalLatency = Date.now() - requestStartTime;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: totalLatency, total: totalLatency },
    tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: responseBody || null,
    response: {
      content: translatedResponse?.choices?.[0]?.message?.content || translatedResponse?.content || null,
      thinking: translatedResponse?.choices?.[0]?.message?.reasoning_content || translatedResponse?.reasoning_content || null,
      finish_reason: translatedResponse?.choices?.[0]?.finish_reason || "unknown"
    },
    status: "success"
  }, { endpoint: clientRawRequest?.endpoint || null })).catch(err => {
    console.error("[RequestDetail] Failed to save:", err.message);
  });

  return {
    success: true,
    response: new Response(JSON.stringify(translatedResponse), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    })
  };
}
