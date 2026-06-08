/**
 * Patch A — KiroExecutor must NOT retry 429 on same account.
 * Story 1.6 AC#1, #2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock proxyAwareFetch before importing executor
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshKiroToken: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

function make429Response() {
  return {
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    headers: new Headers(),
    body: null,
  };
}

function make200Response() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
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

describe("Patch A — Kiro 429 retry = 0", () => {
  let executor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new KiroExecutor();
  });

  it("returns immediately on 429 without any retry (exactly 1 fetch call)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(make429Response());

    const result = await executor.execute({
      model: "kiro/auto",
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: "token-abc" },
      signal: null,
      log: null,
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
    expect(result.response.ok).toBe(false);
  });

  it("does not delay before returning 429 (no sleep)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(make429Response());

    const t0 = Date.now();
    await executor.execute({
      model: "kiro/auto",
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: "token-abc" },
      signal: null,
      log: null,
    });
    const elapsed = Date.now() - t0;

    // With retry=0 there should be no 2s delay; well under 1s
    expect(elapsed).toBeLessThan(1000);
  });

  it("other status codes are unaffected (200 succeeds normally)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(make200Response());

    const result = await executor.execute({
      model: "kiro/auto",
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: "token-abc" },
      signal: null,
      log: null,
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(200);
  });
});
