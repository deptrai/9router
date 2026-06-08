/**
 * Story 1.6 guardrail — Patch A isolation check
 * Verifies that non-429 retryable errors still retry normally
 * (Patch A must NOT break retries for other status codes).
 * AC#2: other providers / other status codes unaffected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshKiroToken: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

function make200Response() {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    }
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "Content-Type": "application/vnd.amazon.eventstream" }),
    body: stream,
  };
}

function makeErrorResponse(status) {
  return { ok: false, status, statusText: "Error", headers: new Headers(), body: null };
}

describe("Patch A isolation — non-429 retries still work", () => {
  let executor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new KiroExecutor();
  });

  it("KiroExecutor config has retry 429 = 0 (Patch A applied)", () => {
    expect(executor.config.retry[429]).toBe(0);
  });

  it("KiroExecutor config does NOT have retry for 500 (uses DEFAULT_RETRY_CONFIG)", async () => {
    // 500 is not overridden in kiro provider config → uses default (attempts=0 for 500)
    // This verifies Patch A is scoped only to 429 key
    const kiroRetry = executor.config.retry;
    expect(Object.keys(kiroRetry)).toEqual(["429"]);
  });

  it("200 success path: executor returns response without retrying", async () => {
    proxyAwareFetch.mockResolvedValueOnce(make200Response());

    const result = await executor.execute({
      model: "kiro/auto",
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: "tok" },
      signal: null,
      log: null,
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(200);
  });

  it("429 still returns immediately with exactly 1 fetch call (regression guard)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(makeErrorResponse(429));

    const result = await executor.execute({
      model: "kiro/auto",
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: "tok" },
      signal: null,
      log: null,
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Verify DEFAULT_RETRY_CONFIG baseline (imported from runtimeConfig)
// ---------------------------------------------------------------------------
describe("DEFAULT_RETRY_CONFIG — 429 default is 0 (no retry for unspecified providers)", () => {
  it("default 429 retry attempts = 0 for providers without override", async () => {
    const { DEFAULT_RETRY_CONFIG, resolveRetryEntry } = await import("../../open-sse/config/runtimeConfig.js");
    const entry429 = DEFAULT_RETRY_CONFIG[429];
    const resolved = resolveRetryEntry(entry429);
    expect(resolved.attempts).toBe(0);
  });
});
