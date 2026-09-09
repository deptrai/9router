import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message, metadata = {}) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  const body = {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };

  if (metadata?.reason) body.error.reason = metadata.reason;
  if (metadata?.code && metadata.code !== errorInfo.code) body.error.provider_code = metadata.code;
  if (metadata?.type && metadata.type !== errorInfo.type) body.error.provider_type = metadata.type;

  return body;
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, metadata = {}) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message, metadata)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/**
 * Normalize an aggregate provider-unavailable state to a retryable HTTP status.
 * A cached/account lock may remember the original upstream status (including
 * request-specific 400s), but once all accounts are locked the router state is
 * availability, not a fresh client bad request.
 */
export function normalizeUnavailableStatus(statusCode) {
  const status = Number(statusCode);
  if (status === 429) return 429;
  if (status === 502 || status === 503 || status === 504) return status;
  return 503;
}

function stringifyValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function stringifyOptional(value) {
  if (value == null || value === "") return undefined;
  return typeof value === "string" ? value : String(value);
}

function parseProviderErrorBody(bodyText) {
  if (!bodyText) return {};
  try {
    const json = JSON.parse(bodyText);
    const err = json?.error;
    const payload = err && typeof err === "object" && !Array.isArray(err) ? err : json;
    const message = payload?.message ?? json?.message ?? (typeof err === "string" ? err : "");
    return {
      message: stringifyValue(message),
      reason: stringifyOptional(payload?.reason ?? json?.reason),
      code: stringifyOptional(payload?.code ?? json?.code),
      type: stringifyOptional(payload?.type ?? json?.type),
      raw: json,
    };
  } catch {
    return { message: bodyText };
  }
}

function isRawBodyEcho(message, bodyText) {
  return typeof message === "string" && message.trim() === (bodyText || "").trim();
}

function withProviderMetadata(message, { reason, code } = {}) {
  const details = [];
  if (reason && !message.includes(reason)) details.push(`reason=${reason}`);
  if (code && code !== reason && !message.includes(code)) details.push(`code=${code}`);
  return details.length ? `${message} (${details.join(", ")})` : message;
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number, reason?: string, code?: string, type?: string}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  const bodyError = parseProviderErrorBody(bodyText);

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const parsedMessage = stringifyValue(parsed.message);
        const msg = (!parsedMessage || isRawBodyEcho(parsedMessage, bodyText))
          ? bodyError.message
          : parsedMessage;
        const finalMessage = msg || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        const metadata = {
          reason: parsed.reason || bodyError.reason,
          code: parsed.code || bodyError.code,
          type: parsed.type || bodyError.type,
        };
        return {
          statusCode: parsed.status || response.status,
          message: withProviderMetadata(finalMessage, metadata),
          resetsAtMs: parsed.resetsAtMs,
          ...metadata,
        };
      }
    } catch { /* fall through to default parsing */ }
  }

  const finalMessage = bodyError.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  return {
    statusCode: response.status,
    message: withProviderMetadata(finalMessage, bodyError),
    reason: bodyError.reason,
    code: bodyError.code,
    type: bodyError.type,
  };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @param {object} [metadata] - Optional provider-specific error metadata
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, metadata = {}) {
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    errorReason: metadata.reason,
    errorCode: metadata.code,
    errorType: metadata.type,
    response: errorResponse(statusCode, message, metadata)
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
