import { PROVIDER_MODELS } from "@/shared/constants/models";
import { getSettings } from "@/lib/localDb";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format
 */
export async function GET(request) {
  try {
    // R2-P0-2: honour requireApiKey the same way all other v1 handlers do.
    // Wrap in try/catch so a DB failure does not prevent the models list from loading.
    try {
      const settings = await getSettings();
      if (settings.requireApiKey && request) {
        const apiKey = extractApiKey(request);
        if (!apiKey) {
          return Response.json({ error: { message: "Missing API key", code: 401 } }, { status: 401 });
        }
        const valid = await isValidApiKey(apiKey);
        if (!valid) {
          return Response.json({ error: { message: "Invalid API key", code: 401 } }, { status: 401 });
        }
      }
    } catch {
      // getSettings failure — fall through (treat as requireApiKey=false)
    }

    // Collect all models from all providers
    const models = [];

    for (const [provider, providerModels] of Object.entries(PROVIDER_MODELS)) {
      for (const model of providerModels) {
        models.push({
          name: `models/${provider}/${model.id}`,
          displayName: model.name || model.id,
          description: `${provider} model: ${model.name || model.id}`,
          supportedGenerationMethods: ["generateContent"],
          inputTokenLimit: model.contextWindow ?? 128000,
          outputTokenLimit: model.maxOutputTokens ?? 8192,
        });
      }
    }

    return Response.json({ models });
  } catch (error) {
    console.error("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}

