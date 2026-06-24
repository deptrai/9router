/**
 * Contract tests for open-sse/handlers/chatCore.js — handleChatCore()
 *
 * Mocking strategy (mirrors embeddingsCore.test.js):
 *  - vi.mock executors/index.js  → inject a controllable executor per test
 *  - vi.mock tokenRefresh        → suppress real token refresh logic
 *  - vi.mock proxyFetch          → suppress proxy-agent import
 *  - vi.mock @/lib/usageDb       → no-op all DB writes
 *  - vi.mock @/lib/db/index.js   → no-op (imported transitively via usageDb shim)
 *  - vi.mock open-sse/index.js   → suppress side-effectful top-level import in chat.js
 *  - vi.mock open-sse/utils/claudeHeaderCache.js → no-op
 *  - vi.mock open-sse/utils/requestLogger.js     → return a lightweight logger stub
 *  - vi.mock open-sse/services/combo.js          → suppress DB-backed combo lookup
 *  - vi.mock @/lib/quota/rpmLimit.js             → always allow
 *  - vi.mock @/lib/billing/checkCredits.js       → always allow
 *  - vi.mock @/lib/quota/keyQuota.js             → always allow
 *  - vi.mock @/lib/quota/planQuota.js            → always allow
 *  - vi.mock ../services/auth.js                 → return a minimal credential object
 *  - vi.mock ../services/model.js                → resolve model to provider/model
 *  - vi.mock ../services/tokenRefresh.js (src)   → no-op
 *  - vi.mock open-sse/services/projectId.js      → no-op
 *  - vi.mock open-sse/utils/autoCompact.js       → controllable per test
 *  - vi.mock open-sse/rtk/index.js               → no-op
 *  - vi.mock open-sse/rtk/caveman.js             → no-op
 *
 * Test level chosen: handleChatCore DIRECTLY (same pattern as embeddingsCore.test.js).
 * handleChat/handleSingleModelChat carry too many auth/quota/DB layers that would need
 * a full integration environment. handleChatCore is the real logic boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock: executor layer (uuid dep in kiro.js) ───────────────────────────────
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(),
}));

// ─── Mock: token refresh ──────────────────────────────────────────────────────
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn().mockResolvedValue(null),
}));

// ─── Mock: proxyFetch (proxy-agent not installed in test env) ─────────────────
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
}));

// ─── Mock: DB / usage tracking (SQLite not available in test env) ─────────────
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
  saveRequestDetail: vi.fn().mockResolvedValue(undefined),
  saveRequestUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db/index.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
  saveRequestDetail: vi.fn().mockResolvedValue(undefined),
  saveRequestUsage: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockResolvedValue({}),
}));

// ─── Mock: requestLogger (filesystem writes) ──────────────────────────────────
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn().mockResolvedValue({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
    logComplete: vi.fn(),
    logUsage: vi.fn(),
  }),
}));

// ─── Mock: autoCompact (controllable per test) ────────────────────────────────
vi.mock("../../open-sse/utils/autoCompact.js", () => ({
  applyAutoCompact: vi.fn().mockReturnValue(null),
}));

// ─── Mock: RTK modules ───────────────────────────────────────────────────────
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn().mockReturnValue(null),
  formatRtkLog: vi.fn().mockReturnValue(null),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({
  injectCaveman: vi.fn(),
}));

// ─── Mock: open-sse/services/projectId.js ────────────────────────────────────
vi.mock("../../open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn().mockResolvedValue(null),
}));

// ─── Now import what we're actually testing ───────────────────────────────────
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { applyAutoCompact } from "../../open-sse/utils/autoCompact.js";
import {
  noopLog,
  makeExecutorMock,
  makeCompletionBody,
  assertOpenAIEnvelope,
  assertOpenAIError,
} from "./_helpers/openai-mock.js";

// ─── Base options factory ─────────────────────────────────────────────────────

// NOTE: use "claude" provider for non-stream tests.
// chatCore hardcodes providerRequiresStreaming=true for "openai"/"codex"/"commandcode",
// which forces stream=true regardless of body.stream. "claude" has no such override.
function makeOpts(overrides = {}) {
  return {
    body: {
      model: "claude/claude-3-5-sonnet",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    },
    modelInfo: { provider: "claude", model: "claude-3-5-sonnet" },
    credentials: { apiKey: "sk-test" },
    log: noopLog,
    onCredentialsRefreshed: vi.fn(),
    onRequestSuccess: vi.fn(),
    onSettled: vi.fn(),
    onDisconnect: vi.fn(),
    ...overrides,
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(applyAutoCompact).mockReturnValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Non-streaming happy path ──────────────────────────────────────────────────

describe("handleChatCore — non-stream happy path", () => {
  it("returns success=true with a Response on 200", async () => {
    vi.mocked(getExecutor).mockReturnValue(makeExecutorMock({ stream: false }));

    const result = await handleChatCore(makeOpts());

    expect(result.success).toBe(true);
    expect(result.response).toBeInstanceOf(Response);
    expect(result.response.status).toBe(200);
  });

  it("response body has OpenAI chat.completion envelope (choices + usage)", async () => {
    vi.mocked(getExecutor).mockReturnValue(makeExecutorMock({ stream: false }));

    const result = await handleChatCore(makeOpts());
    const body = await result.response.json();

    assertOpenAIEnvelope(body);
  });

  it("response has CORS header Access-Control-Allow-Origin: *", async () => {
    vi.mocked(getExecutor).mockReturnValue(makeExecutorMock({ stream: false }));

    const result = await handleChatCore(makeOpts());

    expect(result.response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("calls onRequestSuccess callback on success", async () => {
    vi.mocked(getExecutor).mockReturnValue(makeExecutorMock({ stream: false }));
    const onRequestSuccess = vi.fn();

    await handleChatCore(makeOpts({ onRequestSuccess }));

    expect(onRequestSuccess).toHaveBeenCalledOnce();
  });
});

// ─── Streaming happy path ─────────────────────────────────────────────────────

describe("handleChatCore — stream happy path", () => {
  it("returns Response with Content-Type text/event-stream when stream=true", async () => {
    vi.mocked(getExecutor).mockReturnValue(makeExecutorMock({ stream: true }));

    const result = await handleChatCore(makeOpts({
      body: {
        model: "claude/claude-3-5-sonnet",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      },
    }));

    // streaming handler returns Response directly (not wrapped in {success, response})
    const response = result.response ?? result;
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  });
});

// ─── Executor network error → 502 ────────────────────────────────────────────

describe("handleChatCore — executor throws network error", () => {
  it("returns success=false with status 502 when executor.execute throws", async () => {
    const executor = makeExecutorMock();
    executor.execute = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts());

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });

  it("error body has OpenAI error.message containing the network error", async () => {
    const executor = makeExecutorMock();
    executor.execute = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts());
    const body = await result.response.json();

    assertOpenAIError(body, { messageMatch: "ECONNREFUSED" });
  });
});

// ─── Provider 401 ─────────────────────────────────────────────────────────────

describe("handleChatCore — provider 401", () => {
  it("returns success=false when provider returns 401 and no refresh succeeds", async () => {
    const executor = makeExecutorMock({ status: 401 });
    // Override response to be a proper 401 not-ok response
    const response401 = new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    executor.execute = vi.fn().mockResolvedValue({
      response: response401,
      url: "https://api.test.example/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts());

    expect(result.success).toBe(false);
    // status may be 401 (propagated) — verify it's a client/auth error, not 200
    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── Provider 429 ─────────────────────────────────────────────────────────────

describe("handleChatCore — provider 429", () => {
  it("propagates 429 from provider as success=false status=429", async () => {
    const response429 = new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    const executor = makeExecutorMock();
    executor.execute = vi.fn().mockResolvedValue({
      response: response429,
      url: "https://api.test.example/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts());

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
  });

  it("error body has error.message", async () => {
    const response429 = new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    const executor = makeExecutorMock();
    executor.execute = vi.fn().mockResolvedValue({
      response: response429,
      url: "https://api.test.example/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts());
    const body = await result.response.json();

    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("message");
  });
});

// ─── autoCompact disabled + tooLarge → 400 context_window_exceeded ────────────

describe("handleChatCore — autoCompact disabled + tooLarge", () => {
  it("returns 400 with code=context_window_exceeded when autoCompact disabled and input too large", async () => {
    vi.mocked(applyAutoCompact).mockReturnValue({
      disabled: true,
      tooLarge: true,
      beforeTokens: 200_000,
      limitTokens: 150_000,
    });
    // Executor should NOT be called — error is pre-flight
    const executor = makeExecutorMock();
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts());

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.errorCode).toBe("context_window_exceeded");
  });

  it("error body has error.message mentioning context window", async () => {
    vi.mocked(applyAutoCompact).mockReturnValue({
      disabled: true,
      tooLarge: true,
      beforeTokens: 200_000,
      limitTokens: 150_000,
    });
    vi.mocked(getExecutor).mockReturnValue(makeExecutorMock());

    const result = await handleChatCore(makeOpts());
    const body = await result.response.json();

    expect(body.error.message).toMatch(/context|limit|token/i);
  });

  it("does NOT call executor.execute when pre-flight rejects", async () => {
    vi.mocked(applyAutoCompact).mockReturnValue({
      disabled: true,
      tooLarge: true,
      beforeTokens: 200_000,
      limitTokens: 150_000,
    });
    const executor = makeExecutorMock();
    vi.mocked(getExecutor).mockReturnValue(executor);

    await handleChatCore(makeOpts());

    expect(executor.execute).not.toHaveBeenCalled();
  });
});

// ─── autoCompact applied + still tooLarge → 400 ───────────────────────────────

describe("handleChatCore — autoCompact applied but still tooLarge", () => {
  it("returns 400 with code=context_window_exceeded", async () => {
    vi.mocked(applyAutoCompact).mockReturnValue({
      applied: true,
      tooLarge: true,
      beforeTokens: 200_000,
      afterTokens: 160_000,
      limitTokens: 150_000,
      omittedCount: 5,
    });
    vi.mocked(getExecutor).mockReturnValue(makeExecutorMock());

    const result = await handleChatCore(makeOpts());

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.errorCode).toBe("context_window_exceeded");
  });
});

// ─── Error result shape contract ──────────────────────────────────────────────

describe("handleChatCore — error result shape", () => {
  it("createErrorResult shape: {success:false, status, error, response}", async () => {
    const response429 = new Response(JSON.stringify({ error: { message: "ratelimit" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    const executor = makeExecutorMock();
    executor.execute = vi.fn().mockResolvedValue({
      response: response429,
      url: "https://api.test.example",
      headers: {},
      transformedBody: null,
    });
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts());

    expect(result).toHaveProperty("success", false);
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("response");
    expect(result.response).toBeInstanceOf(Response);
  });
});
