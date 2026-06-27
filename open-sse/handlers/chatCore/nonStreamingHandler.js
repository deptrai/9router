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

// Tool-call format constants — must match openai-to-claude.js
const TC_OPEN = "<tool_call>";
const TC_CLOSE = "</tool_call>";

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
      const openIdx = remaining.indexOf(TC_OPEN);
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
      const closeIdx = afterOpen.indexOf(TC_CLOSE);
      if (closeIdx === -1) {
        // Incomplete — emit as text
        content.push({ type: "text", text: TC_OPEN + afterOpen });
        break;
      }
      const body = afterOpen.slice(0, closeIdx).trim();
      const afterClose = afterOpen.slice(closeIdx + TC_CLOSE.length);
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

  // OpenAI → Claude: translate OpenAI ChatCompletion to Anthropic Messages format
  // This is needed when the client sends Anthropic format (/v1/messages) but the
  // provider returns OpenAI format (e.g. Windsurf executor).
  if (sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.CLAUDE) {
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
