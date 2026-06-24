/**
 * Contract tests for /v1/responses and /v1/responses/compact routes.
 *
 * /v1/responses/route.js  — thin wrapper: calls handleChat(request) directly.
 * /v1/responses/compact/route.js — reads body, injects _compact=true, then
 *   calls handleChat with a new Request.
 *
 * Test level: route handler (mock handleChat, verify forwarding + _compact injection).
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

import { POST as responsesPost, OPTIONS as responsesOptions } from "../../src/app/api/v1/responses/route.js";
import { POST as compactPost, OPTIONS as compactOptions } from "../../src/app/api/v1/responses/compact/route.js";
import { handleChat } from "@/sse/handlers/chat.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResponsesRequest(body = {}) {
  const defaultBody = {
    model: "gpt-4o",
    input: [{ role: "user", content: "Hello" }],
    ...body,
  };
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaultBody),
  });
}

function makeCompactRequest(body = {}) {
  const defaultBody = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    ...body,
  };
  return new Request("http://localhost/v1/responses/compact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaultBody),
  });
}

function makeOKResponse(extra = {}) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      ...extra,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(handleChat).mockResolvedValue(makeOKResponse());
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── /v1/responses ─────────────────────────────────────────────────────────────

describe("/v1/responses route — OPTIONS preflight", () => {
  it("returns 200 with CORS headers", async () => {
    const res = await responsesOptions();
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("/v1/responses route — POST forwards to handleChat", () => {
  it("calls handleChat exactly once", async () => {
    await responsesPost(makeResponsesRequest());
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it("returns status 200 from handleChat", async () => {
    const res = await responsesPost(makeResponsesRequest());
    expect(res.status).toBe(200);
  });

  it("passes a Request instance to handleChat", async () => {
    await responsesPost(makeResponsesRequest());
    const [arg] = vi.mocked(handleChat).mock.calls[0];
    expect(arg).toBeInstanceOf(Request);
  });

  it("returns response body intact (JSON passthrough)", async () => {
    vi.mocked(handleChat).mockResolvedValue(makeOKResponse({ id: "resp-unique" }));
    const res = await responsesPost(makeResponsesRequest());
    const body = await res.json();
    expect(body.id).toBe("resp-unique");
  });

  it("propagates 400 error from handleChat", async () => {
    vi.mocked(handleChat).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
    const res = await responsesPost(makeResponsesRequest());
    expect(res.status).toBe(400);
  });
});

// ── /v1/responses/compact ─────────────────────────────────────────────────────

describe("/v1/responses/compact route — OPTIONS preflight", () => {
  it("returns 200 with CORS headers", async () => {
    const res = await compactOptions();
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("/v1/responses/compact route — POST injects _compact=true", () => {
  it("calls handleChat exactly once", async () => {
    await compactPost(makeCompactRequest());
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it("injects _compact=true into the body forwarded to handleChat", async () => {
    await compactPost(makeCompactRequest());
    const [req] = vi.mocked(handleChat).mock.calls[0];
    const forwarded = await req.json();
    expect(forwarded._compact).toBe(true);
  });

  it("preserves original body fields alongside _compact", async () => {
    await compactPost(makeCompactRequest({ model: "claude-3-haiku", stream: false }));
    const [req] = vi.mocked(handleChat).mock.calls[0];
    const forwarded = await req.json();
    expect(forwarded.model).toBe("claude-3-haiku");
    expect(forwarded._compact).toBe(true);
  });

  it("returns status 200 from handleChat", async () => {
    const res = await compactPost(makeCompactRequest());
    expect(res.status).toBe(200);
  });

  it("passes a Request instance (not the original) to handleChat", async () => {
    const original = makeCompactRequest();
    await compactPost(original);
    const [arg] = vi.mocked(handleChat).mock.calls[0];
    expect(arg).toBeInstanceOf(Request);
    // compact route creates a new Request — it should not be the same object
    expect(arg).not.toBe(original);
  });
});
