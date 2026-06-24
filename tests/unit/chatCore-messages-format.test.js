/**
 * Contract tests for /v1/messages route (Anthropic/Claude format).
 *
 * Both /v1/messages/route.js and /v1/responses/route.js are thin wrappers
 * that call handleChat(request) directly — format detection happens inside
 * the translator pipeline. Testing at route level: mock handleChat, verify
 * the route forwards correctly and returns the response unchanged.
 *
 * Test level: route handler (POST from messages/route.js)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── vi.mock must be hoisted before any import ─────────────────────────────────

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: vi.fn(),
}));

vi.mock("open-sse/translator/index.js", () => ({
  initTranslators: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { POST, OPTIONS } from "../../src/app/api/v1/messages/route.js";
import { handleChat } from "@/sse/handlers/chat.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAnthropicRequest(body = {}) {
  const defaultBody = {
    model: "claude-3-5-sonnet-20241022",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 100,
    ...body,
  };
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaultBody),
  });
}

function makeOpenAIJsonResponse(body = {}) {
  const defaultBody = {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    ...body,
  };
  return new Response(JSON.stringify(defaultBody), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(handleChat).mockResolvedValue(makeOpenAIJsonResponse());
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("/v1/messages route — OPTIONS preflight", () => {
  it("returns 200 with CORS headers", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("/v1/messages route — POST forwards to handleChat", () => {
  it("calls handleChat exactly once", async () => {
    const req = makeAnthropicRequest();
    await POST(req);
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it("returns the Response that handleChat produces (status 200)", async () => {
    const req = makeAnthropicRequest();
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("passes a Request object to handleChat", async () => {
    const req = makeAnthropicRequest();
    await POST(req);
    const [passedArg] = vi.mocked(handleChat).mock.calls[0];
    expect(passedArg).toBeInstanceOf(Request);
  });

  it("forwards response body intact (JSON passthrough)", async () => {
    vi.mocked(handleChat).mockResolvedValue(makeOpenAIJsonResponse({ id: "chatcmpl-unique" }));
    const req = makeAnthropicRequest();
    const res = await POST(req);
    const body = await res.json();
    expect(body.id).toBe("chatcmpl-unique");
  });
});

describe("/v1/messages route — POST with Anthropic-shaped body", () => {
  it("handles multi-turn Anthropic messages array", async () => {
    const req = makeAnthropicRequest({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "How are you?" },
      ],
    });
    await POST(req);
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it("handles request with system prompt field", async () => {
    const req = makeAnthropicRequest({ system: "You are helpful." });
    await POST(req);
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it("propagates error response from handleChat (e.g. 400)", async () => {
    vi.mocked(handleChat).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
    const req = makeAnthropicRequest();
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
