/**
 * Contract tests for /v1beta/models/[...path] route (Gemini format).
 *
 * route.js behavior confirmed from source:
 *  - params.path is a Promise in Next.js App Router → must await params
 *  - path length >= 2: ["provider", "model:action"] → model = "provider/modelName"
 *  - path length == 1: ["model:action"]             → model = "modelName"
 *  - action ":generateContent"       → stream=false → convertOpenAIResponseToGemini()
 *  - action ":streamGenerateContent" → stream=true  → transformOpenAISSEToGeminiSSE()
 *  - convertGeminiToInternal() maps {contents, systemInstruction} → {model, messages, stream}
 *  - convertOpenAIResponseToGemini() maps OpenAI JSON → {candidates:[{content:{role,parts},finishReason,index}], modelVersion, usageMetadata}
 *  - transformOpenAISSEToGeminiSSE() maps OpenAI SSE → Gemini SSE (no [DONE], stream-close instead)
 *
 * Test level: route handler (mock handleChat, verify Gemini shape output).
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

import { POST, OPTIONS } from "../../src/app/api/v1beta/models/[...path]/route.js";
import { handleChat } from "@/sse/handlers/chat.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Gemini-format request body */
function makeGeminiBody(overrides = {}) {
  return {
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    ...overrides,
  };
}

/**
 * Build a POST request simulating Next.js App Router params.
 * params is a Promise (Next 15+), route does: const { path } = await params
 */
function makeGeminiRequest(pathSegments, body = makeGeminiBody()) {
  const req = new Request("http://localhost/v1beta/models/" + pathSegments.join("/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Next.js App Router passes params as a Promise
  const params = Promise.resolve({ path: pathSegments });
  return { req, params };
}

/** OpenAI JSON completion response (for :generateContent non-stream path) */
function makeOpenAIJsonResponse(overrides = {}) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi from Gemini!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** OpenAI SSE response (for :streamGenerateContent stream path) */
function makeOpenAISSEResponse({ content = "Hi!", finish_reason = "stop" } = {}) {
  const chunk = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    model: "test-model",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  });
  const done = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });
  const body = `data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Read all Gemini SSE chunks from a streaming Response */
async function readGeminiSSE(response) {
  const text = await response.text();
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  return lines.map((l) => JSON.parse(l.slice(5).trim()));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(handleChat).mockResolvedValue(makeOpenAIJsonResponse());
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── OPTIONS ───────────────────────────────────────────────────────────────────

describe("/v1beta/models/[...path] — OPTIONS preflight", () => {
  it("returns 200 with CORS headers", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ── :generateContent (non-stream) — Gemini JSON output ───────────────────────

describe("/v1beta/models/[...path] — :generateContent (non-stream)", () => {
  it("calls handleChat once", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:generateContent"]);
    await POST(req, { params });
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it("returns status 200", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:generateContent"]);
    const res = await POST(req, { params });
    expect(res.status).toBe(200);
  });

  it("response body has Gemini candidates array", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:generateContent"]);
    const res = await POST(req, { params });
    const body = await res.json();
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates.length).toBeGreaterThan(0);
  });

  it("candidate has content.role='model' and parts array", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:generateContent"]);
    const res = await POST(req, { params });
    const body = await res.json();
    const candidate = body.candidates[0];
    expect(candidate.content.role).toBe("model");
    expect(Array.isArray(candidate.content.parts)).toBe(true);
  });

  it("candidate has finishReason (STOP for finish_reason:stop)", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:generateContent"]);
    const res = await POST(req, { params });
    const body = await res.json();
    expect(body.candidates[0].finishReason).toBe("STOP");
  });

  it("response has modelVersion field", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:generateContent"]);
    const res = await POST(req, { params });
    const body = await res.json();
    expect(body).toHaveProperty("modelVersion");
  });

  it("response has usageMetadata with token counts", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:generateContent"]);
    const res = await POST(req, { params });
    const body = await res.json();
    expect(body.usageMetadata).toBeDefined();
    expect(body.usageMetadata).toHaveProperty("promptTokenCount");
    expect(body.usageMetadata).toHaveProperty("candidatesTokenCount");
    expect(body.usageMetadata).toHaveProperty("totalTokenCount");
  });
});

// ── path parsing — 2-segment (provider/model) ────────────────────────────────

describe("/v1beta/models/[...path] — 2-segment path parsing", () => {
  it("parses provider/model:generateContent correctly (calls handleChat)", async () => {
    const { req, params } = makeGeminiRequest(["openai", "gpt-4o:generateContent"]);
    await POST(req, { params });
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it("forwarded body contains model=provider/modelName", async () => {
    const { req, params } = makeGeminiRequest(["openai", "gpt-4o:generateContent"]);
    await POST(req, { params });
    const [passedReq] = vi.mocked(handleChat).mock.calls[0];
    const body = await passedReq.json();
    expect(body.model).toBe("openai/gpt-4o");
  });
});

// ── path parsing — 1-segment (model only) ────────────────────────────────────

describe("/v1beta/models/[...path] — 1-segment path parsing", () => {
  it("parses model:generateContent correctly (calls handleChat)", async () => {
    const { req, params } = makeGeminiRequest(["gemini-1.5-pro:generateContent"]);
    await POST(req, { params });
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it("forwarded body contains model=modelName (no provider prefix)", async () => {
    const { req, params } = makeGeminiRequest(["gemini-1.5-pro:generateContent"]);
    await POST(req, { params });
    const [passedReq] = vi.mocked(handleChat).mock.calls[0];
    const body = await passedReq.json();
    expect(body.model).toBe("gemini-1.5-pro");
  });
});

// ── Gemini request body conversion (convertGeminiToInternal) ─────────────────

describe("/v1beta/models/[...path] — Gemini body conversion", () => {
  it("converts contents[role=user] → messages[role=user]", async () => {
    const { req, params } = makeGeminiRequest(
      ["gemini-pro:generateContent"],
      { contents: [{ role: "user", parts: [{ text: "Say hi" }] }] }
    );
    await POST(req, { params });
    const [passedReq] = vi.mocked(handleChat).mock.calls[0];
    const body = await passedReq.json();
    expect(body.messages.some((m) => m.role === "user")).toBe(true);
  });

  it("converts contents[role=model] → messages[role=assistant]", async () => {
    const { req, params } = makeGeminiRequest(
      ["gemini-pro:generateContent"],
      {
        contents: [
          { role: "user", parts: [{ text: "Hi" }] },
          { role: "model", parts: [{ text: "Hello!" }] },
          { role: "user", parts: [{ text: "How are you?" }] },
        ],
      }
    );
    await POST(req, { params });
    const [passedReq] = vi.mocked(handleChat).mock.calls[0];
    const body = await passedReq.json();
    expect(body.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("converts systemInstruction → system message prepended", async () => {
    const { req, params } = makeGeminiRequest(
      ["gemini-pro:generateContent"],
      {
        systemInstruction: { parts: [{ text: "You are helpful." }] },
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      }
    );
    await POST(req, { params });
    const [passedReq] = vi.mocked(handleChat).mock.calls[0];
    const body = await passedReq.json();
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("You are helpful.");
  });

  it("sets stream=false for :generateContent", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:generateContent"]);
    await POST(req, { params });
    const [passedReq] = vi.mocked(handleChat).mock.calls[0];
    const body = await passedReq.json();
    expect(body.stream).toBe(false);
  });

  it("sets stream=true for :streamGenerateContent", async () => {
    vi.mocked(handleChat).mockResolvedValue(makeOpenAISSEResponse());
    const { req, params } = makeGeminiRequest(["gemini-pro:streamGenerateContent"]);
    await POST(req, { params });
    const [passedReq] = vi.mocked(handleChat).mock.calls[0];
    const body = await passedReq.json();
    expect(body.stream).toBe(true);
  });
});

// ── :streamGenerateContent — Gemini SSE output ───────────────────────────────

describe("/v1beta/models/[...path] — :streamGenerateContent (stream)", () => {
  beforeEach(() => {
    vi.mocked(handleChat).mockResolvedValue(makeOpenAISSEResponse({ content: "Hi stream!" }));
  });

  it("returns Content-Type text/event-stream", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:streamGenerateContent"]);
    const res = await POST(req, { params });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("returns status 200", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:streamGenerateContent"]);
    const res = await POST(req, { params });
    expect(res.status).toBe(200);
  });

  it("SSE chunks have Gemini candidates shape", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:streamGenerateContent"]);
    const res = await POST(req, { params });
    const chunks = await readGeminiSSE(res);
    expect(chunks.length).toBeGreaterThan(0);
    expect(Array.isArray(chunks[0].candidates)).toBe(true);
  });

  it("content chunk has candidates[0].content.role='model'", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:streamGenerateContent"]);
    const res = await POST(req, { params });
    const chunks = await readGeminiSSE(res);
    const contentChunk = chunks.find(
      (c) => c.candidates?.[0]?.content?.parts?.some((p) => p.text)
    );
    expect(contentChunk).toBeDefined();
    expect(contentChunk.candidates[0].content.role).toBe("model");
  });

  it("final chunk has finishReason=STOP", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:streamGenerateContent"]);
    const res = await POST(req, { params });
    const chunks = await readGeminiSSE(res);
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.candidates[0].finishReason).toBe("STOP");
  });

  it("final chunk has usageMetadata", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:streamGenerateContent"]);
    const res = await POST(req, { params });
    const chunks = await readGeminiSSE(res);
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.usageMetadata).toBeDefined();
    expect(finalChunk.usageMetadata).toHaveProperty("promptTokenCount");
    expect(finalChunk.usageMetadata).toHaveProperty("candidatesTokenCount");
  });

  it("no [DONE] sentinel in Gemini SSE output", async () => {
    const { req, params } = makeGeminiRequest(["gemini-pro:streamGenerateContent"]);
    const res = await POST(req, { params });
    const text = await res.text();
    expect(text).not.toContain("[DONE]");
  });
});
