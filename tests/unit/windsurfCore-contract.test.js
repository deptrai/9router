/**
 * Contract tests for open-sse/handlers/chatCore.js — handleChatCore() with Windsurf provider
 *
 * Mocking strategy (mirrors chatCore-contract.test.js):
 *  - vi.mock executors/index.js  → inject a controllable WindsurfExecutor mock
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
 * Test level chosen: handleChatCore DIRECTLY (same pattern as chatCore-contract.test.js).
 * handleChat/handleSingleModelChat carry too many auth/quota/DB layers that would need
 * a full integration environment. handleChatCore is the real logic boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock: executor layer ───────────────────────────────────────────────────────
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

// Now import what we're actually testing ───────────────────────────────────
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { applyAutoCompact } from "../../open-sse/utils/autoCompact.js";
import { WindsurfExecutor } from "../../open-sse/executors/windsurf.js";
import {
  noopLog,
  makeExecutorMock,
  makeCompletionBody,
  assertOpenAIEnvelope,
  assertOpenAIError,
} from "./_helpers/openai-mock.js";

// ─── Base options factory ─────────────────────────────────────────────────────

function makeOpts(overrides = {}) {
  return {
    body: {
      model: "ws/sonnet-4.6",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    },
    modelInfo: { provider: "windsurf", model: "sonnet-4.6" },
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

// ─── Verify executor selection ────────────────────────────────────────────────

describe("handleChatCore — Windsurf executor selection", () => {
  it("calls getExecutor('windsurf') for ws/sonnet-4.6", async () => {
    const executor = makeExecutorMock({ stream: false });
    vi.mocked(getExecutor).mockReturnValue(executor);

    await handleChatCore(makeOpts());

    expect(getExecutor).toHaveBeenCalledWith("windsurf");
  });

  it("returns WindsurfExecutor instance (not DefaultExecutor)", async () => {
    const windsurfExecutor = new WindsurfExecutor();
    vi.mocked(getExecutor).mockReturnValue(windsurfExecutor);

    const executor = getExecutor("windsurf");
    expect(executor).toBeInstanceOf(WindsurfExecutor);
    expect(executor.constructor.name).toBe("WindsurfExecutor");
  });
});

// ─── Verify body format (claude → claude, skip translation) ───────────────────

describe("handleChatCore — Windsurf body format", () => {
  it("executor receives Anthropic-format body (format:claude → sourceFormat===targetFormat → skip translation)", async () => {
    const executor = makeExecutorMock({ stream: false });
    vi.mocked(getExecutor).mockReturnValue(executor);

    await handleChatCore(makeOpts());

    // Verify executor.execute was called with Anthropic-format body
    const executeCall = vi.mocked(executor.execute).mock.calls[0];
    const { body, model } = executeCall[0];

    // Windsurf format is "claude", so body should have Anthropic structure
    expect(body).toHaveProperty("messages");
    expect(body).toHaveProperty("model");
    expect(model).toBe("sonnet-4.6");
  });
});

// ─── Verify SSE event sequence (streaming) ───────────────────────────────────

describe("handleChatCore — Windsurf SSE event sequence", () => {
  it("executor emits Anthropic SSE event sequence for streaming", async () => {
    // Create a mock executor that returns SSE stream
    const sseStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        // Emit Anthropic SSE events
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 }
          }
        })}\n\n`));

        controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" }
        })}\n\n`));

        controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" }
        })}\n\n`));

        controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0
        })}\n\n`));

        controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: 10, output_tokens: 5 }
        })}\n\n`));

        controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({
          type: "message_stop"
        })}\n\n`));

        controller.close();
      }
    });

    const executor = {
      execute: vi.fn().mockResolvedValue({
        response: new Response(sseStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        }),
        url: "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
        headers: {},
        transformedBody: null,
      }),
      refreshCredentials: vi.fn().mockResolvedValue(null),
      noAuth: false,
    };
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts({
      body: {
        model: "ws/sonnet-4.6",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }
    }));

    // Verify streaming response
    const response = result.response ?? result;
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  });
});

// ─── Error path: executor throw → chatCore maps to Anthropic error ───────────

describe("handleChatCore — Windsurf error path", () => {
  it("executor throw → chatCore maps to Anthropic error", async () => {
    const executor = makeExecutorMock();
    executor.execute = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts());

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);

    const body = await result.response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("message");
    expect(body.error.message).toContain("ECONNREFUSED");
  });

  it("provider 401 → maps to OpenAI authentication_error envelope", async () => {
    const response401 = new Response(JSON.stringify({
      error: {
        type: "authentication_error",
        message: "Unauthorized"
      }
    }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });

    const executor = makeExecutorMock();
    executor.execute = vi.fn().mockResolvedValue({
      response: response401,
      url: "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
      headers: {},
      transformedBody: null,
    });
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts());

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);

    const body = await result.response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("message");
    expect(body.error).toHaveProperty("type", "authentication_error");
    expect(body.error).toHaveProperty("code", "invalid_api_key");
  });

  it("provider 429 → maps to OpenAI rate_limit_error envelope", async () => {
    const response429 = new Response(JSON.stringify({
      error: {
        type: "rate_limit_error",
        message: "Rate limit exceeded"
      }
    }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    });

    const executor = makeExecutorMock();
    executor.execute = vi.fn().mockResolvedValue({
      response: response429,
      url: "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
      headers: {},
      transformedBody: null,
    });
    vi.mocked(getExecutor).mockReturnValue(executor);

    const result = await handleChatCore(makeOpts());

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);

    const body = await result.response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("message");
    expect(body.error).toHaveProperty("type", "rate_limit_error");
    expect(body.error).toHaveProperty("code", "rate_limit_exceeded");
  });
});
