/**
 * Shared test helpers for OpenAI-format contract tests.
 * NOT a test file — no describe/it at top level.
 * The include glob is **\/*.test.js so this file is never collected as a suite.
 */
import { expect, vi } from "vitest";

// ── Logging no-op ─────────────────────────────────────────────────────────────
export const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Provider response factories ───────────────────────────────────────────────

/** Minimal success Response that looks like it came from a provider */
export function makeProviderResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Minimal error Response from a provider */
export function makeProviderErrorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Non-stream provider response body ────────────────────────────────────────

/** OpenAI-format chat completion body (non-stream) */
export function makeCompletionBody({ content = "ok", usage = null } = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: usage || { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

/** SSE stream body (two data chunks + [DONE]) */
export function makeStreamBody({ content = "ok" } = {}) {
  const chunk = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  });
  const done = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });
  return `data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
}

/**
 * Build an executor mock whose execute() returns a provider Response.
 * stream=false → JSON body, stream=true → SSE body.
 */
export function makeExecutorMock({ content = "ok", usage = null, stream = false, status = 200 } = {}) {
  const body = stream ? makeStreamBody({ content }) : JSON.stringify(makeCompletionBody({ content, usage }));
  const ct = stream ? "text/event-stream" : "application/json";
  const response = new Response(body, {
    status,
    headers: { "Content-Type": ct },
  });
  return {
    execute: vi.fn().mockResolvedValue({
      response,
      url: "https://api.test.example/v1/chat/completions",
      headers: { Authorization: "Bearer test" },
      transformedBody: null,
    }),
    refreshCredentials: vi.fn().mockResolvedValue(null),
    noAuth: false,
    parseError: null,
  };
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

/**
 * Assert a parsed response body has OpenAI chat completion shape.
 * Usage: const body = await result.response.json(); assertOpenAIEnvelope(body);
 */
export function assertOpenAIEnvelope(body) {
  expect(Array.isArray(body.choices)).toBe(true);
  expect(body.choices.length).toBeGreaterThan(0);
  expect(body.choices[0]).toHaveProperty("message");
  expect(body.usage).toBeDefined();
}

/**
 * Assert a parsed response body has OpenAI error shape.
 * @param {object} body - Parsed JSON body
 * @param {object} opts
 * @param {number}  [opts.status]       - Expected HTTP status (pass result.status)
 * @param {RegExp|string} [opts.messageMatch] - Pattern to match error.message
 */
export function assertOpenAIError(body, { status, messageMatch } = {}) {
  expect(body).toHaveProperty("error");
  expect(body.error).toHaveProperty("message");
  if (status !== undefined) {
    // caller should separately check result.status === status
  }
  if (messageMatch !== undefined) {
    if (messageMatch instanceof RegExp) {
      expect(body.error.message).toMatch(messageMatch);
    } else {
      expect(body.error.message).toContain(messageMatch);
    }
  }
}
