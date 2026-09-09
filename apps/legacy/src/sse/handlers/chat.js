import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse, unavailableResponse, normalizeUnavailableStatus } from "open-sse/utils/error.js";
import { handleComboChat, getModelContextFit, estimateRequestInputTokens } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { checkKeyQuota } from "@/lib/quota/keyQuota.js";
import { checkCredits, checkPerKeyLimit } from "@/lib/billing/checkCredits.js";
import { checkRpmLimit } from "@/lib/quota/rpmLimit.js";
import { checkPlanQuota } from "@/lib/quota/planQuota.js";
import { getApiKeyByKey } from "@/lib/localDb";

/**
 * Recursively sanitize a JSON Schema object for Bedrock draft 2020-12 compatibility.
 * Converts "type": ["T", "null"] → "type": "T", removes "format": "uint", "default": null.
 */
function sanitizeSchemaForBedrock(schema) {
  if (!schema || typeof schema !== "object") return;
  // Convert "type": ["T", "null"] → "type": "T"
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter(t => t !== "null");
    if (nonNull.length === 1) schema.type = nonNull[0];
  }
  // Remove invalid format values
  if (schema.format === "uint" || schema.format === "uint64") delete schema.format;
  // Remove "default": null
  if (schema.default === null) delete schema.default;
  // Recurse into properties
  if (schema.properties) {
    for (const prop of Object.values(schema.properties)) {
      sanitizeSchemaForBedrock(prop);
    }
  }
  // Recurse into items
  if (schema.items) sanitizeSchemaForBedrock(schema.items);
  // Recurse into anyOf/oneOf/allOf
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key])) {
      schema[key].forEach(s => sanitizeSchemaForBedrock(s));
    }
  }
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  // Log request endpoint and model
  const url = new URL(request.url);
  const modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  // Sanitize tool schemas for Bedrock compatibility (draft 2020-12)
  // Deep-clone before sanitizing to prevent prototype pollution from untrusted client input
  if (body.tools?.length) {
    let sanitized = 0;
    for (const tool of body.tools) {
      // Handle all possible schema locations — operate on deep clone to avoid __proto__ pollution
      if (tool.input_schema) {
        try { tool.input_schema = JSON.parse(JSON.stringify(tool.input_schema)); } catch { /* keep original on clone failure */ }
        sanitizeSchemaForBedrock(tool.input_schema); sanitized++;
      }
      if (tool.custom?.input_schema) {
        try { tool.custom.input_schema = JSON.parse(JSON.stringify(tool.custom.input_schema)); } catch { /* keep original */ }
        sanitizeSchemaForBedrock(tool.custom.input_schema); sanitized++;
      }
      if (tool.function?.parameters) {
        try { tool.function.parameters = JSON.parse(JSON.stringify(tool.function.parameters)); } catch { /* keep original */ }
        sanitizeSchemaForBedrock(tool.function.parameters); sanitized++;
      }
    }
    if (sanitized > 0) log.info("SANITIZE", `Sanitized ${sanitized}/${body.tools.length} tool schemas for Bedrock compatibility`);
  }

  // Early-reject: if estimated input tokens exceed model's effective context limit by >10%,
  // reject immediately instead of wasting a 2-3s network roundtrip to upstream.
  const fit = getModelContextFit(body, body.model, estimateRequestInputTokens);
  if (fit && fit.effectiveLimit && !fit.fits) {
    log.warn("CONTEXT", `Early-reject: ~${fit.estimatedTokens} tokens > ${fit.effectiveLimit} limit (model=${body.model})`);
    return new Response(
      JSON.stringify({ error: { message: `Request too large: estimated ${fit.estimatedTokens} tokens exceeds model context limit of ${fit.effectiveLimit}`, type: "invalid_request_error", code: "context_length_exceeded" } }),
      { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // RPM admission — count per-user BEFORE combo expansion (1 client request = 1 RPM,
  // regardless of how many models a combo tries). Bypass requests above don't count RPM.
  const rpmResult = await checkRpmLimit(apiKey);
  if (!rpmResult.allowed) {
    log.warn("RPM", `key="${log.maskKey(apiKey || "")}" RPM exceeded ${rpmResult.count}/${rpmResult.rpm} (plan ${rpmResult.planName}) ${rpmResult.retryAfterHuman || ""}`);
    return unavailableResponse(HTTP_STATUS.RATE_LIMITED, `[plan ${rpmResult.planName}] RPM limit exceeded (${rpmResult.count}/${rpmResult.rpm})`, rpmResult.retryAfter, rpmResult.retryAfterHuman);
  }

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      bufferedFallbackEnabled: !!settings.bufferedFallbackEnabled
    });
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      
      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        bufferedFallbackEnabled: !!chatSettings.bufferedFallbackEnabled
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Log model routing (alias → actual model)
  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // --- Quota enforcement (AC#1-7, Story 1.3) ---
  // Kiểm tra sau khi resolve canonical model, trước khi lấy credentials
  const quota = await checkKeyQuota(apiKey, model);
  if (!quota.allowed) {
    log.warn("QUOTA", `[${provider}/${model}] key="${log.maskKey(apiKey || "")}" quota exceeded — consumed ${quota.limit?.consumed ?? "?"}/${quota.limit?.maxTokens ?? "?"} tokens (${quota.limit?.window ?? "?"}) ${quota.retryAfterHuman || ""}`);
    return unavailableResponse(
      HTTP_STATUS.RATE_LIMITED,
      `[${provider}/${model}] quota exceeded`,
      quota.retryAfter,
      quota.retryAfterHuman
    );
  }

  // --- Plan quota + credit — Model B (Story 2.14, E.3) ---
  // Replaces bare checkCredits. Determines billingSource: "plan" | "overflow" | "credit".
  // checkKeyQuota (above, per-key legacy quota) is kept independent.
  // Story 2.23 (D1=Option 2): per-key credit limit is a blast-radius guardrail —
  // enforce on EVERY admission regardless of billing source (plan/overflow/credit).
  // usageHistory.cost is recorded for all requests incl. plan-billed, so the cap
  // applies uniformly. Fail-open inside checkPerKeyLimit.
  const keyLimitResult = await checkPerKeyLimit(apiKey);
  if (!keyLimitResult.allowed) {
    log.warn("BILLING", `[${provider}/${model}] key="${log.maskKey(apiKey || "")}" per-key limit: ${keyLimitResult.reason}`);
    return unavailableResponse(HTTP_STATUS.RATE_LIMITED, keyLimitResult.reason || "key credit limit reached", 60, "60s");
  }

  let billingSource;
  const pq = await checkPlanQuota(apiKey, model);
  if (pq.source === "plan" && pq.allowed) {
    // Within plan quota — no credit deduction
    billingSource = "plan";
  } else if (pq.source === "plan" && !pq.allowed) {
    // Plan exists but quota exhausted (plan+!allowed always implies exhausted)
    if (pq.allowCreditOverflow) {
      // Plan exhausted + overflow ON → fall through to credit billing
      const creditResult = await checkCredits(apiKey);
      if (!creditResult.allowed) {
        log.warn("BILLING", `[${provider}/${model}] key="${log.maskKey(apiKey || "")}" overflow credit check failed: ${creditResult.reason}`);
        return unavailableResponse(HTTP_STATUS.RATE_LIMITED, creditResult.reason || "insufficient credits", 60, "60s");
      }
      billingSource = "overflow";
    } else {
      // Plan exhausted + overflow OFF → 429
      log.warn("QUOTA", `[${provider}/${model}] key="${log.maskKey(apiKey || "")}" plan quota exhausted (${pq.window}) ${pq.retryAfterHuman || ""}`);
      return unavailableResponse(
        HTTP_STATUS.RATE_LIMITED,
        `[plan ${pq.planName}] quota exhausted (${pq.window}) — enable credit overflow to continue`,
        pq.retryAfter,
        pq.retryAfterHuman
      );
    }
  } else {
    // source=credit/none/error → pay-as-you-go (story 2.4 behaviour, no regression)
    const creditResult = await checkCredits(apiKey);
    if (!creditResult.allowed) {
      log.warn("BILLING", `[${provider}/${model}] key="${log.maskKey(apiKey || "")}" credit check failed: ${creditResult.reason}`);
      return unavailableResponse(HTTP_STATUS.RATE_LIMITED, creditResult.reason || "insufficient credits", 60, "60s");
    }
    // On infra error in plan resolution (source="error"), do NOT deduct credit:
    // fail-open must not penalize the user for our own error (we couldn't confirm plan state).
    billingSource = pq.source === "error" ? "plan" : "credit";
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Resolve userId once before retry loop — thread into opts for entitlement routing (2.29b).
  // Guard: only query when apiKey present (local/no-auth mode has null apiKey → skip).
  const keyRow = apiKey ? await getApiKeyByKey(apiKey).catch(() => null) : null;
  const routingUserId = keyRow?.userId ?? null;

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { userId: routingUserId });

    // owned_only entitlement — owned connection unavailable (policy block, AC5)
    if (credentials?.ownedOnlyUnavailable) {
      log.warn("CHAT", `[${provider}] owned_only block: ${credentials.reason}`);
      return errorResponse(HTTP_STATUS.FORBIDDEN ?? 403, credentials.reason);
    }

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = normalizeUnavailableStatus(lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE);
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    let lease = credentials._lease || null;
    let handed = false;
    try {
      // Log account selection
      log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

      const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

      // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
      if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
        const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
        if (pid) {
          refreshedCredentials.projectId = pid;
          // Persist to DB in background so subsequent requests have it immediately
          updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
        }
      }

      // Use shared chatCore
      const chatSettings = await getSettings();
      const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
      const result = await handleChatCore({
        body: { ...body, model: `${provider}/${model}` },
        modelInfo: { provider, model },
        credentials: refreshedCredentials,
        log,
        clientRawRequest,
        connectionId: credentials.connectionId,
        userAgent,
        apiKey,
        billingSource,
        ccFilterNaming: !!chatSettings.ccFilterNaming,
        rtkEnabled: !!chatSettings.rtkEnabled,
        kiroAutoCompactEnabled: !!chatSettings.kiroAutoCompactEnabled,
        cavemanEnabled: !!chatSettings.cavemanEnabled,
        cavemanLevel: chatSettings.cavemanLevel || "full",
        providerThinking,
        // Detect source format by endpoint + body
        sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
        onSettled: () => lease?.release(),
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            accessToken: newCreds.accessToken,
            refreshToken: newCreds.refreshToken,
            providerSpecificData: newCreds.providerSpecificData,
            testStatus: "active"
          });
        },
        onRequestSuccess: async () => {
          await clearAccountError(credentials.connectionId, credentials, model);
        }
      });

      if (result.success) {
        handed = true;
        return result.response;
      }

      // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
      const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

      // Diagnostic: log tool names when Bedrock rejects schema (helps identify which MCP tool is invalid)
      if (result.status === 400 && result.error?.includes?.("TOOL_SCHEMA_INVALID") && body.tools?.length) {
        const toolNames = body.tools.map((t, i) => `${i}:${t.name || t.function?.name || t.custom?.name || "?"}`).join(", ");
        log.warn("TOOL_SCHEMA", `Bedrock rejected tool schema | model=${model} | tools=[${toolNames}]`);
      }

      if (shouldFallback) {
        log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
        excludeConnectionIds.add(credentials.connectionId);
        lastError = result.error;
        lastStatus = result.status;
        continue;
      }

      return result.response;
    } finally {
      if (lease && !handed) lease.release();
    }
  }
}
