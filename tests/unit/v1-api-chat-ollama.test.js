/**
 * Contract tests for /v1/api/chat route (Ollama format).
 *
 * route.js behavior:
 *  1. Clones request, reads body to extract model name (fallback "llama3.2")
 *  2. Calls handleChat(request) to get an OpenAI SSE response
 *  3. Passes that response through transformToOllama(response, modelName)
 *  4. Returns Ollama NDJSON stream
 *
 * Test level: route handler (mock handleChat, verify Ollama transform output).
 *
 * transformToOllama behavior confirmed from source:
 *  - Input: OpenAI SSE stream (data: {...choices[0].delta...}\n\ndata: [DONE]\n\n)
 *  - Output: NDJSON lines, Content-Type: application/x-ndjson
 *  - Each content delta → {model, message:{role:"assistant",content}, done:false}
 *  - [DONE] sentinel → {model, message:{role:"assistant",content:""}, done:true}
 *  - Missing body → empty Response with original status
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── vi.mock hoisted before any import ─────────────────────────────────────────

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: vi.fn(),
}));

vi.mock("open-sse/translator/index.js", () => ({
  initTranslators: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { POST, OPTIONS } from "../../src/app/api/v1/api/chat/route.js";
import { handleChat } from "@/sse/handlers/chat.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build an OpenAI SSE string with one content chunk then [DONE] */
function makeOpenAISSE({ content = "Hi!", model = "test-model", finish_reason = "stop" } = {}) {
  const chunk = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  });
  const done = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: {}, finish_reason }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });
  return `data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
}

function makeSSEResponse(sseBody = makeOpenAISSE()) {
  return new Response(sseBody, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function makeOllamaRequest(body = {}) {
  const defaultBody = { model: "llama3.2", messages: [{ role: "user", content: "Hello" }], ...body };
  return new Request("http://localhost/v1/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaultBody),
  });
}

/** Read all NDJSON lines from a Response body */
async function readNDJSON(response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(handleChat).mockResolvedValue(makeSSEResponse());
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── OPTIONS ───────────────────────────────────────────────────────────────────

describe("/v1/api/chat route — OPTIONS preflight", () => {
  it("returns 200 with CORS headers", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ── POST — content-type & basic forwarding ────────────────────────────────────

describe("/v1/api/chat route — POST basic contract", () => {
  it("calls handleChat exactly once", async () => {
    await POST(makeOllamaRequest());
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it("returns Content-Type application/x-ndjson", async () => {
    const res = await POST(makeOllamaRequest());
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
  });

  it("returns status 200", async () => {
    const res = await POST(makeOllamaRequest());
    expect(res.status).toBe(200);
  });
});

// ── POST — Ollama NDJSON shape ────────────────────────────────────────────────

describe("/v1/api/chat route — POST Ollama output shape", () => {
  it("content line has {model, message:{role,content}, done:false}", async () => {
    vi.mocked(handleChat).mockResolvedValue(makeSSEResponse(makeOpenAISSE({ content: "Hello world" })));
    const res = await POST(makeOllamaRequest({ model: "llama3.2" }));
    const lines = await readNDJSON(res);
    const contentLine = lines.find((l) => l.done === false);
    expect(contentLine).toBeDefined();
    expect(contentLine.model).toBe("llama3.2");
    expect(contentLine.message.role).toBe("assistant");
    expect(typeof contentLine.message.content).toBe("string");
    expect(contentLine.done).toBe(false);
  });

  it("final line has done:true", async () => {
    const res = await POST(makeOllamaRequest());
    const lines = await readNDJSON(res);
    const lastLine = lines[lines.length - 1];
    expect(lastLine.done).toBe(true);
  });

  it("final line has model matching request body model", async () => {
    vi.mocked(handleChat).mockResolvedValue(makeSSEResponse(makeOpenAISSE()));
    const res = await POST(makeOllamaRequest({ model: "mistral:7b" }));
    const lines = await readNDJSON(res);
    const lastLine = lines[lines.length - 1];
    expect(lastLine.model).toBe("mistral:7b");
  });

  it("final line message has role:assistant and content field", async () => {
    const res = await POST(makeOllamaRequest());
    const lines = await readNDJSON(res);
    const lastLine = lines[lines.length - 1];
    expect(lastLine.message.role).toBe("assistant");
    expect(lastLine.message).toHaveProperty("content");
  });
});

// ── POST — model fallback ─────────────────────────────────────────────────────

describe("/v1/api/chat route — model fallback", () => {
  it("uses 'llama3.2' as default model when body has no model field", async () => {
    // Send a request without model field — route falls back to "llama3.2"
    const req = new Request("http://localhost/v1/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    vi.mocked(handleChat).mockResolvedValue(makeSSEResponse(makeOpenAISSE()));
    const res = await POST(req);
    const lines = await readNDJSON(res);
    // All lines should carry the default model name
    expect(lines.every((l) => l.model === "llama3.2")).toBe(true);
  });

  it("uses provided model when body has model field", async () => {
    vi.mocked(handleChat).mockResolvedValue(makeSSEResponse(makeOpenAISSE()));
    const res = await POST(makeOllamaRequest({ model: "phi3:mini" }));
    const lines = await readNDJSON(res);
    expect(lines.every((l) => l.model === "phi3:mini")).toBe(true);
  });
});
