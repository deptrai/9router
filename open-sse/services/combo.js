/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { parseModel } from "./model.js";
import { getModelContextWindow, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { unavailableResponse } from "../utils/error.js";

const DEFAULT_CONTEXT_RESERVE_TOKENS = 4096;
const CONTEXT_ESTIMATE_SAFETY_RATIO = 1.1;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const CONTEXT_WINDOW_ERROR_PATTERNS = [
  "context window",
  "context_window_exceeded",
  "context length",
  "context_length_exceeded",
  "too many input tokens",
  "maximum context length",
];

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

export function isContextWindowError(errorText) {
  if (!errorText) return false;
  const text = typeof errorText === "string" ? errorText : JSON.stringify(errorText);
  const lower = text.toLowerCase();
  return CONTEXT_WINDOW_ERROR_PATTERNS.some(pattern => lower.includes(pattern));
}

function hasPotentialLargerContextCandidate(models, startIndex, currentContextWindow) {
  for (let i = startIndex; i < models.length; i++) {
    const nextContextWindow = resolveModelContextWindow(models[i]);
    if (!currentContextWindow || !nextContextWindow || nextContextWindow > currentContextWindow) {
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

export function getModelContextFit(body, modelStr, estimateInputTokens = estimateRequestInputTokens, reserveTokens = DEFAULT_CONTEXT_RESERVE_TOKENS) {
  const contextWindow = resolveModelContextWindow(modelStr);
  if (!contextWindow) return { fits: true, contextWindow: null, estimatedTokens: 0, requiredTokens: 0 };

  const estimatedTokens = Math.ceil((estimateInputTokens(body) || 0) * CONTEXT_ESTIMATE_SAFETY_RATIO);
  const requestedReserve = getRequestedOutputReserve(body);
  const outputReserve = Math.max(reserveTokens, requestedReserve);
  const requiredTokens = estimatedTokens + outputReserve;

  return {
    fits: requiredTokens <= contextWindow,
    contextWindow,
    estimatedTokens,
    requiredTokens,
  };
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
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, estimateInputTokens = estimateRequestInputTokens }) {
  // Apply rotation strategy if enabled
  const rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    const contextFit = getModelContextFit(body, modelStr, estimateInputTokens);
    if (!contextFit.fits) {
      lastStatus = 400;
      lastError = `[${modelStr}] estimated input ${contextFit.estimatedTokens} tokens (+reserve ${contextFit.requiredTokens - contextFit.estimatedTokens}) exceeds context window ${contextFit.contextWindow}; compact the conversation or use a larger-context fallback`;
      log.warn("COMBO", `Skipping ${modelStr}: context window too small`, contextFit);
      continue;
    }

    try {
      const result = await handleSingleModel(body, modelStr);
      
      // Success (2xx) - return response
      if (result.ok) {
        log.info("COMBO", `Model ${modelStr} succeeded`);
        return result;
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
      } catch {
        // Ignore JSON parse errors
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      if (result.status === 400 && isContextWindowError(errorText)) {
        const currentContextWindow = resolveModelContextWindow(modelStr);
        lastStatus = 400;
        lastError = `[${modelStr}] input exceeds context window${currentContextWindow ? ` ${currentContextWindow}` : ""}; compact the conversation or use a larger-context fallback`;
        const hasLargerFallback = hasPotentialLargerContextCandidate(rotatedModels, i + 1, currentContextWindow);
        log.warn("COMBO", `Model ${modelStr} exceeded context window`, { currentContextWindow, hasLargerFallback });
        if (!hasLargerFallback) {
          return contextWindowErrorResponse(lastError);
        }
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
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      lastError = error.message || String(error);
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

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
