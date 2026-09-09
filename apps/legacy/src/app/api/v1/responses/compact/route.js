import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

let _initPromise = null;

/**
 * Initialize translators once — promise-singleton prevents double-init on concurrent cold requests.
 */
function ensureInitialized() {
  return (_initPromise ??= initTranslators());
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/responses/compact - Compact conversation context
 * Reuses the same handleChat pipeline, signals compact via body._compact
 */
export async function POST(request) {
  await ensureInitialized();
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
  body._compact = true;
  const newRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body)
  });
  return await handleChat(newRequest);
}
