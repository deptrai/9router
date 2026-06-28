/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter, isRequestShapeError } from "./accountFallback.js";
import { parseModel } from "./model.js";
import { getModelContextWindow, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { unavailableResponse } from "../utils/error.js";
import { isContextWindowError } from "../utils/contextWindowError.js";
import { getProviderAutoCompactLimit } from "../utils/autoCompact.js";
import { bufferSSEResponse, buildHeartbeatComboResponse, isStreamingComboRequest } from "../utils/bufferFallback.js";

export { isContextWindowError } from "../utils/contextWindowError.js";

const DEFAULT_CONTEXT_RESERVE_TOKENS = 4096;
const CONTEXT_ESTIMATE_SAFETY_RATIO = 1.1;
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

export function estimateRequestInputTokens(body) {
  try {
    return Math.ceil(JSON.stringify(body || {}).length / CHARS_PER_TOKEN_ESTIMATE);
  } catch {
    return 0;
  }
}

/**
 * Windsurf-aware estimator: accounts for nuclear sanitization that happens
 * inside WindsurfExecutor.execute() BEFORE the request is sent upstream.
 *
 * The default estimator measures the raw body (full system prompt, full tool
 * descriptions, full schema descriptions) — but Windsurf strips all of these,
 * so the actual sent size is ~10-15x smaller. Without this adjustment, the
 * combo preflight blocks ws/* models with a false "exceeds context window".
 *
 * Sanitization mimicked (see WindsurfExecutor.execute):
 * - system: replaced with ~200 char neutral prompt
 * - tools[].description: replaced with `Tool: <name>` (~20 chars)
 * - tools[].input_schema: all descriptions stripped (structure kept only)
 * - messages: <system-reminder> blocks stripped
 */
export function estimateWindsurfInputTokens(body) {
  try {
    if (!body || typeof body !== "object") return 0;

    // System: replaced with neutral prompt (~225 chars in windsurf.js execute())
    const systemChars = 225;

    // Tools: "Tool: <name>" + structural schema (no descriptions)
    let toolsChars = 0;
    if (Array.isArray(body.tools)) {
      for (const t of body.tools) {
        if (!t) continue;
        // description → "Tool: <name>" (6 + name.length) or "Tool" (4)
        toolsChars += t.name ? 6 + (t.name.length || 0) : 4;
        // input_schema structure (type, required, properties keys, enum) — no descriptions
        // Rough estimate: ~80 chars per tool for typical schema structure
        if (t.input_schema && typeof t.input_schema === "object") {
          toolsChars += 80;
        }
      }
    }

    // Messages: strip <system-reminder>...</system-reminder> blocks, keep rest
    let messagesChars = 0;
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg) continue;
        if (typeof msg.content === "string") {
          messagesChars += stripSystemReminderEstimate(msg.content).length;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === "text" && typeof block.text === "string") {
              messagesChars += stripSystemReminderEstimate(block.text).length;
            } else {
              messagesChars += JSON.stringify(block || {}).length;
            }
          }
        } else {
          messagesChars += JSON.stringify(msg.content || "").length;
        }
        // role + overhead
        messagesChars += 30;
      }
    }

    // Other fields (model, max_tokens, stream, etc.) — small overhead
    const otherChars = 200;

    const totalChars = systemChars + toolsChars + messagesChars + otherChars;
    return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE);
  } catch {
    return 0;
  }
}

function stripSystemReminderEstimate(text) {
  if (typeof text !== "string") return String(text || "");
  // Non-greedy match for closed tags + unclosed fallback (same as WindsurfExecutor)
  let result = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  result = result.replace(/<system-reminder>[\s\S]*$/gi, "");
  return result;
}

/**
 * Pick the appropriate token estimator based on provider.
 * Windsurf sanitizes the body heavily before sending, so it needs a
 * provider-aware estimator to avoid false context-window rejections.
 */
function pickEstimator(modelStr) {
  const parsed = parseModel(modelStr);
  const alias = parsed?.providerAlias?.toLowerCase();
  const provider = parsed?.provider?.toLowerCase();
  if (alias === "ws" || provider === "windsurf") {
    return estimateWindsurfInputTokens;
  }
  return estimateRequestInputTokens;
}

function getRequestedOutputReserve(body) {
  const raw = body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function resolveModelContextWindow(modelStr) {
  const parsed = parseModel(modelStr);
  if (!parsed?.model) return null;
  const aliases = [parsed.providerAlias, PROVIDER_ID_TO_ALIAS[parsed.provider], parsed.provider]
    .filter(Boolean);
  for (const alias of aliases) {
    const contextWindow = getModelContextWindow(alias, parsed.model);
    if (contextWindow) return contextWindow;
  }
  return null;
}

function resolveModelInputLimit(modelStr) {
  const parsed = parseModel(modelStr);
  if (!parsed?.model) return null;
  const providers = [parsed.providerAlias, PROVIDER_ID_TO_ALIAS[parsed.provider], parsed.provider]
    .filter(Boolean);
  for (const provider of providers) {
    const limit = getProviderAutoCompactLimit(provider, parsed.model);
    if (limit) return limit;
  }
  return null;
}

function resolveModelContextLimits(modelStr) {
  const contextWindow = resolveModelContextWindow(modelStr);
  const inputLimit = resolveModelInputLimit(modelStr);
  const effectiveLimit = inputLimit && contextWindow ? Math.min(inputLimit, contextWindow) : (inputLimit || contextWindow);
  return { contextWindow, inputLimit, effectiveLimit };
}

function hasPotentialLargerContextCandidate(models, startIndex, currentEffectiveLimit, requiredTokens = null) {
  const currentLimit = Number.isFinite(currentEffectiveLimit) && currentEffectiveLimit > 0
    ? currentEffectiveLimit
    : null;
  const requiredLimit = Number.isFinite(requiredTokens) && requiredTokens > 0
    ? requiredTokens
    : null;

  for (let i = startIndex; i < models.length; i++) {
    const { effectiveLimit: nextEffectiveLimit } = resolveModelContextLimits(models[i]);
    if (!Number.isFinite(nextEffectiveLimit) || nextEffectiveLimit <= 0) {
      continue;
    }
    if (requiredLimit && nextEffectiveLimit < requiredLimit) {
      continue;
    }
    if (!currentLimit || nextEffectiveLimit > currentLimit) {
      return true;
    }
  }
  return false;
}

function contextWindowErrorResponse(message) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "invalid_request_error",
        code: "context_window_exceeded",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

function appendErrorPart(parts, value) {
  if (value == null || value === "") return;
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  try { parts.push(JSON.stringify(value)); } catch { parts.push(String(value)); }
}

function normalizeRetryAfter(value) {
  if (value == null || value === "") return null;
  const raw = typeof value === "string" ? value.trim() : String(value);
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const seconds = Number.parseInt(raw, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function extractComboErrorInfo(errorBody, fallbackText = "") {
  const parts = [];
  const err = errorBody?.error;
  if (err && typeof err === "object") {
    appendErrorPart(parts, err.message);
    appendErrorPart(parts, err.code);
    appendErrorPart(parts, err.provider_code);
    appendErrorPart(parts, err.reason);
    appendErrorPart(parts, err.type);
    appendErrorPart(parts, err.provider_type);
  } else {
    appendErrorPart(parts, err);
  }
  appendErrorPart(parts, errorBody?.message);
  appendErrorPart(parts, errorBody?.code);
  appendErrorPart(parts, errorBody?.reason);

  return {
    errorText: parts.join(" ") || fallbackText,
    retryAfter: normalizeRetryAfter(errorBody?.retryAfter || (err && typeof err === "object" ? err.retryAfter : null)),
  };
}

export function getModelContextFit(body, modelStr, estimateInputTokens = null, reserveTokens = DEFAULT_CONTEXT_RESERVE_TOKENS) {
  const { contextWindow, inputLimit, effectiveLimit } = resolveModelContextLimits(modelStr);
  if (!effectiveLimit) return { fits: true, contextWindow: null, inputLimit: null, effectiveLimit: null, estimatedTokens: 0, requiredTokens: 0 };

  // Pick estimator: if caller provides one, use it; otherwise auto-select by provider
  const estimator = estimateInputTokens || pickEstimator(modelStr);
  const estimatedTokens = Math.ceil((estimator(body) || 0) * CONTEXT_ESTIMATE_SAFETY_RATIO);
  const requestedReserve = getRequestedOutputReserve(body);
  const outputReserve = Math.max(reserveTokens, requestedReserve);
  const requiredTokens = estimatedTokens + outputReserve;

  return {
    fits: requiredTokens <= effectiveLimit,
    contextWindow,
    inputLimit,
    effectiveLimit,
    estimatedTokens,
    requiredTokens,
  };
}

function describeContextLimit(contextFit) {
  if (contextFit.inputLimit && (!contextFit.contextWindow || contextFit.inputLimit < contextFit.contextWindow)) {
    return `provider input limit ${contextFit.inputLimit}`;
  }
  return `context window ${contextFit.contextWindow || contextFit.effectiveLimit}`;
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, estimateInputTokens = null, bufferedFallbackEnabled = false, bufferTimeoutMs = undefined }) {
  // Apply rotation strategy if enabled
  const rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;
  let lastContextError = null;
  let lastContextStatus = null;
  let lastOutcome = null;

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    const contextFit = getModelContextFit(body, modelStr, estimateInputTokens);
    if (!contextFit.fits) {
      const hasLargerFallback = hasPotentialLargerContextCandidate(
        rotatedModels,
        i + 1,
        contextFit.effectiveLimit || contextFit.contextWindow,
        contextFit.requiredTokens,
      );
      if (!contextFit.inputLimit || hasLargerFallback) {
        lastContextStatus = 400;
        lastContextError = `[${modelStr}] estimated input ${contextFit.estimatedTokens} tokens (+reserve ${contextFit.requiredTokens - contextFit.estimatedTokens}) exceeds ${describeContextLimit(contextFit)}; compact the conversation or use a larger-context fallback`;
        lastOutcome = "context";
        log.warn("COMBO", `Skipping ${modelStr}: context window too small`, { ...contextFit, hasLargerFallback });
        continue;
      }
      log.warn("COMBO", `Trying ${modelStr} with auto-compact because no larger fallback is available`, contextFit);
    }

    try {
      const result = await handleSingleModel(body, modelStr);

      // Success (2xx) - return response
      if (result.ok) {
        // Buffered fallback path: instead of piping the stream straight through
        // (which commits the 200 header and makes mid-stream truncation
        // unrecoverable), buffer the whole translated SSE body server-side. If
        // the upstream cut off mid-response (no terminal marker), transparently
        // try the next combo model (e.g. vuz → viber) without the client ever
        // seeing an error. Heartbeat keeps the connection alive while buffering.
        if (bufferedFallbackEnabled && isStreamingComboRequest(body)) {
          log.info("COMBO_BUFFER", `Model ${modelStr} returned 200, buffering before commit`);
          const startIndex = i;
          return buildHeartbeatComboResponse(async (abortSignal) => {
            // First attempt: the model we already have an open response for.
            const first = await bufferSSEResponse(result, bufferTimeoutMs, abortSignal);
            if (!first.truncated && first.hasContent) {
              log.info("COMBO_BUFFER", `Model ${modelStr} buffered OK (${first.rawSSE.length} bytes)`);
              return { rawSSE: first.rawSSE };
            }
            log.warn("COMBO_BUFFER", `Model ${modelStr} truncated/empty, trying fallback models`);

            // Fall back through the remaining models in rotation order.
            for (let j = startIndex + 1; j < rotatedModels.length; j++) {
              if (abortSignal?.aborted) throw new Error("client disconnected during buffered fallback");
              const fbModel = rotatedModels[j];
              // Skip models that can't fit this request, mirroring the outer
              // combo loop. Without this the buffered loop wastes a full upstream
              // round-trip on a guaranteed 400 context-window error.
              const fbFit = getModelContextFit(body, fbModel, estimateInputTokens);
              if (!fbFit.fits && fbFit.inputLimit) {
                const fbHasLarger = hasPotentialLargerContextCandidate(
                  rotatedModels, j + 1,
                  fbFit.effectiveLimit || fbFit.contextWindow,
                  fbFit.requiredTokens,
                );
                if (fbHasLarger) {
                  log.warn("COMBO_BUFFER", `Skipping ${fbModel}: context window too small`);
                  continue;
                }
              }
              log.info("COMBO_BUFFER", `Buffered retry with ${fbModel}`);
              let fbResult;
              try {
                fbResult = await handleSingleModel(body, fbModel);
              } catch (e) {
                log.warn("COMBO_BUFFER", `Fallback ${fbModel} threw: ${e?.message}`);
                continue;
              }
              if (!fbResult.ok) {
                log.warn("COMBO_BUFFER", `Fallback ${fbModel} HTTP ${fbResult.status}`);
                try { await fbResult.body?.cancel?.(); } catch { /* noop */ }
                continue;
              }
              const fb = await bufferSSEResponse(fbResult, bufferTimeoutMs, abortSignal);
              if (!fb.truncated && fb.hasContent) {
                log.info("COMBO_BUFFER", `Fallback ${fbModel} buffered OK (${fb.rawSSE.length} bytes)`);
                return { rawSSE: fb.rawSSE };
              }
              log.warn("COMBO_BUFFER", `Fallback ${fbModel} also truncated/empty`);
            }
            throw new Error(`All combo models truncated mid-stream: ${rotatedModels.slice(startIndex).join(", ")}`);
          });
        }

        log.info("COMBO", `Model ${modelStr} succeeded`);
        return result;
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        ({ errorText, retryAfter } = extractComboErrorInfo(errorBody, errorText));
      } catch {
        // Ignore JSON parse errors
      }
      retryAfter = retryAfter || normalizeRetryAfter(result.headers?.get?.("Retry-After"));

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      if (result.status === 400 && isContextWindowError(errorText)) {
        const { effectiveLimit: currentContextWindow } = resolveModelContextLimits(modelStr);
        lastContextStatus = 400;
        lastContextError = `[${modelStr}] input exceeds context window${currentContextWindow ? ` ${currentContextWindow}` : ""}; compact the conversation or use a larger-context fallback`;
        lastOutcome = "context";
        const hasLargerFallback = hasPotentialLargerContextCandidate(rotatedModels, i + 1, currentContextWindow);
        log.warn("COMBO", `Model ${modelStr} exceeded context window`, { currentContextWindow, hasLargerFallback });
        if (!hasLargerFallback) {
          return contextWindowErrorResponse(lastContextError);
        }
        continue;
      }

      if (result.status === 400 && isRequestShapeError(errorText)) {
        lastStatus = 400;
        lastError = `[${modelStr}] ${errorText || "request shape error"}`;
        lastOutcome = "provider";
        log.warn("COMBO", `Model ${modelStr} returned request-shape 400, trying next`, { status: result.status });
        continue;
      }

      // Check if should fallback to next model
      const { shouldFallback, cooldownMs } = checkFallbackError(result.status, errorText);

      if (!shouldFallback) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503)
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(r => setTimeout(r, cooldownMs));
      }

      // Fallback to next model
      lastError = errorText || String(result.status);
      if (!lastStatus) lastStatus = result.status;
      lastOutcome = "provider";
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      lastError = error.message || String(error);
      if (!lastStatus) lastStatus = 500;
      lastOutcome = "provider";
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const useContextResult = lastOutcome === "context";
  const finalError = useContextResult ? lastContextError : (lastError || lastContextError);
  const finalStatus = useContextResult ? lastContextStatus : (lastStatus || lastContextStatus);
  const allDisabled = finalError && finalError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (finalStatus || 503);
  const msg = finalError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  if (status === 400 && isContextWindowError(msg)) {
    return contextWindowErrorResponse(msg);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
