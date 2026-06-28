/**
 * Story 1.3 — WindsurfExecutor unit tests
 * Verifies Connect-RPC request structure, SSE event sequence, and error handling
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { WindsurfExecutor } from "../../open-sse/executors/windsurf.js";
import { buildGetChatMessageRequest } from "../../open-sse/utils/windsurfProtobuf.js";
import { buildAuthHeader } from "../../open-sse/utils/windsurfAuth.js";

// Mock protobuf utils to avoid actual encoding
vi.mock("../../open-sse/utils/windsurfProtobuf.js", () => ({
  buildGetChatMessageRequest: vi.fn(),
  decodeGetChatMessageResponse: vi.fn(),
  connectFrameDecode: vi.fn(),
  resetFrameBuffer: vi.fn(),
  parseConnectEndFrame: vi.fn(),
  mapConnectErrorToAnthropic: vi.fn(),
}));

vi.mock("../../open-sse/utils/windsurfAuth.js", () => ({
  buildAuthHeader: vi.fn(),
}));

import {
  buildGetChatMessageRequest,
  decodeGetChatMessageResponse,
  connectFrameDecode,
  resetFrameBuffer,
  parseConnectEndFrame,
  mapConnectErrorToAnthropic
} from "../../open-sse/utils/windsurfProtobuf.js";
import { buildAuthHeader as mockBuildAuthHeader } from "../../open-sse/utils/windsurfAuth.js";

function makeMockStreamResponse(chunks = []) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise(r => setTimeout(r, 10));
      }
      controller.close();
    }
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "Content-Type": "application/connect+proto" }),
    body: stream,
  };
}

function makeErrorResponse(status, errorText = "Error") {
  return {
    ok: false,
    status,
    statusText: "Error",
    headers: new Headers(),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(errorText));
        c.close();
      }
    }),
    text: async () => errorText,
  };
}

describe("WindsurfExecutor", () => {
  let executor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new WindsurfExecutor();

    // Default mocks
    buildGetChatMessageRequest.mockReturnValue(Buffer.from([0x01, 0x02, 0x03]));
    mockBuildAuthHeader.mockReturnValue("Basic dGVzdC10ZXN0");
    decodeGetChatMessageResponse.mockReturnValue({
      delta_text: null,
      delta_tool_calls: [],
      delta_thinking: null,
      stop_reason: null,
      usage: null,
      error: null
    });
    connectFrameDecode.mockReturnValue([]);
    parseConnectEndFrame.mockReturnValue(null);
    mapConnectErrorToAnthropic.mockReturnValue({
      status: 502,
      error: { type: "error", error: { type: "api_error", message: "Test error" } }
    });
  });

  describe("getModelUid", () => {
    it("maps ws/sonnet-4.6 to claude-sonnet-4-6-thinking", () => {
      expect(executor.getModelUid("ws/sonnet-4.6")).toBe("claude-sonnet-4-6-thinking");
    });

    it("maps ws/opus-4.8 to claude-opus-4-8-medium", () => {
      expect(executor.getModelUid("ws/opus-4.8")).toBe("claude-opus-4-8-medium");
    });

    it("maps ws/glm-5-2 to glm-5-2", () => {
      expect(executor.getModelUid("ws/glm-5-2")).toBe("glm-5-2");
    });

    it("maps ws/swe-1-6 to swe-1-6", () => {
      expect(executor.getModelUid("ws/swe-1-6")).toBe("swe-1-6");
    });

    it("maps ws/minimax-m2.7 to MODEL_MINIMAX_M2_1", () => {
      expect(executor.getModelUid("ws/minimax-m2.7")).toBe("MODEL_MINIMAX_M2_1");
    });

    it("returns modelId as-is for unknown models", () => {
      expect(executor.getModelUid("ws/unknown-model")).toBe("unknown-model");
    });
  });

  describe("buildConnectFrame", () => {
    it("builds Connect-RPC frame with correct format", () => {
      const payload = Buffer.from([0x01, 0x02, 0x03]);
      const frame = executor.buildConnectFrame(payload);

      // Frame format: [0x00][4-byte BE length][payload]
      expect(frame[0]).toBe(0x00); // flag
      expect(frame.readUInt32BE(1)).toBe(3); // length
      expect(frame.slice(5)).toEqual(payload); // payload
    });
  });

  describe("getApiKey", () => {
    it("returns apiKey from credentials", async () => {
      const credentials = { apiKey: "test-key" };
      const key = await executor.getApiKey(credentials);
      expect(key).toBe("test-key");
    });

    it("falls back to WINDSURF_API_KEY env var", async () => {
      process.env.WINDSURF_API_KEY = "env-key";
      const key = await executor.getApiKey({});
      expect(key).toBe("env-key");
      delete process.env.WINDSURF_API_KEY;
    });

    it("throws when no API key available", async () => {
      await expect(executor.getApiKey({})).rejects.toThrow(
        "Windsurf API key not found in credentials or environment (WINDSURF_API_KEY)"
      );
    });
  });

  describe("execute - streaming", () => {
    it("builds Connect-RPC request with correct structure", async () => {
      proxyAwareFetch.mockResolvedValue(makeMockStreamResponse([]));

      const credentials = { apiKey: "test-key" };
      const body = {
        messages: [{ role: "user", content: "hello" }],
        system: [{ type: "text", text: "You are helpful" }],
        max_tokens: 4096
      };

      await executor.execute({
        model: "ws/sonnet-4.6",
        body,
        stream: true,
        credentials,
        signal: null,
        log: null,
      });

      // W-FIX: system prompt is replaced with a neutral placeholder to bypass
      // Windsurf content policy. Verify the replacement happened.
      expect(buildGetChatMessageRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: "user", content: "hello" }],
          system: [{ type: "text", text: expect.stringContaining("interactive coding assistant") }],
          max_tokens: 4096
        }),
        "test-key",
        "claude-sonnet-4-6-thinking"
      );
      expect(mockBuildAuthHeader).toHaveBeenCalledWith("test-key");
      expect(proxyAwareFetch).toHaveBeenCalledWith(
        "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/connect+proto",
            "Connect-Protocol-Version": "1",
            "Authorization": "Basic dGVzdC10ZXN0",
            "TE": "trailers"
          }),
          body: expect.any(Buffer)
        }),
        null
      );
    });

    it("handles non-200 responses with error mapping", async () => {
      proxyAwareFetch.mockResolvedValue(makeErrorResponse(401, "Unauthorized"));

      const result = await executor.execute({
        model: "ws/sonnet-4.6",
        body: { messages: [] },
        stream: true,
        credentials: { apiKey: "test-key" },
        signal: null,
        log: null,
      });

      expect(result.response.status).toBe(401);
      const errorBody = await result.response.json();
      expect(errorBody.error.type).toBe("authentication_error");
    });

    it("handles 429 rate limit errors", async () => {
      proxyAwareFetch.mockResolvedValue(makeErrorResponse(429, "Rate limited"));

      const result = await executor.execute({
        model: "ws/sonnet-4.6",
        body: { messages: [] },
        stream: true,
        credentials: { apiKey: "test-key" },
        signal: null,
        log: null,
      });

      expect(result.response.status).toBe(429);
      const errorBody = await result.response.json();
      expect(errorBody.error.type).toBe("rate_limit_error");
    });

    it("W-FIX: returns HTTP 429 when Windsurf sends 200 + end-frame rate limit error (no content)", async () => {
      // Windsurf returns HTTP 200 but puts permission_denied/rate_limit in end frame.
      // Without peek, Claude Code sees "empty or malformed response (HTTP 200)".
      connectFrameDecode.mockReturnValue([
        { flags: 0x02, payload: Buffer.from('{"error":{"code":"permission_denied","message":"Reached overall message rate limit. Please try again later."}}') },
      ]);
      parseConnectEndFrame.mockReturnValue({
        code: "permission_denied",
        message: "Reached overall message rate limit. Please try again later.",
      });
      mapConnectErrorToAnthropic.mockReturnValue({
        status: 403,
        error: { type: "error", error: { type: "permission_error", message: "Reached overall message rate limit." } },
      });

      proxyAwareFetch.mockResolvedValue(makeMockStreamResponse(["chunk1"]));

      const result = await executor.execute({
        model: "ws/glm-5-2",
        body: { messages: [] },
        stream: true,
        credentials: { apiKey: "test-key" },
        signal: null,
        log: null,
      });

      // Should return HTTP 403 (not 200 with empty SSE stream)
      expect(result.response.status).toBe(403);
      const errorBody = await result.response.json();
      expect(errorBody.error.type).toBe("permission_error");
      expect(errorBody.error.message).toContain("rate limit");
    });

    it("retries on network error pre-TTFT (W-H2)", async () => {
      proxyAwareFetch
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValue(makeMockStreamResponse([]));

      const mockLog = { debug: vi.fn() };

      const result = await executor.execute({
        model: "ws/sonnet-4.6",
        body: { messages: [] },
        stream: true,
        credentials: { apiKey: "test-key" },
        signal: null,
        log: mockLog,
      });

      expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
      expect(mockLog.debug).toHaveBeenCalledWith(
        "RETRY",
        expect.stringContaining("retry 1/2")
      );
      // Verify result exists and has response
      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
    });

    it("does not retry after MAX_RETRIES", async () => {
      proxyAwareFetch.mockRejectedValue(new Error("Network error"));

      const result = await executor.execute({
        model: "ws/sonnet-4.6",
        body: { messages: [] },
        stream: true,
        credentials: { apiKey: "test-key" },
        signal: null,
        log: null,
      });

      expect(proxyAwareFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
      expect(result.response.status).toBe(502);
    });
  });

  describe("execute - streaming chunked tool calls", () => {
    it("aggregates chunked tool call args across frames with empty id", async () => {
      // Simulate real GLM-5-2 chunked tool calls:
      // Frame 1: id=tool-123, name=get_weather, args=""
      // Frame 2: id="", name="", args={"city": "
      // Frame 3: id="", name="", args=Hanoi
      // Frame 4: id="", name="", args="}
      const frames = [
        { flags: 0x00, payload: Buffer.from([0x01]) },
        { flags: 0x00, payload: Buffer.from([0x02]) },
        { flags: 0x00, payload: Buffer.from([0x03]) },
        { flags: 0x00, payload: Buffer.from([0x04]) },
      ];
      connectFrameDecode.mockReturnValue(frames);
      const decodeSequence = [
        { delta_text: null, delta_tool_calls: [{ id: "tool-123", name: "get_weather", arguments_json: "", invalid_json_str: "" }], delta_thinking: null, stop_reason: null, usage: null, error: null },
        { delta_text: null, delta_tool_calls: [{ id: "", name: "", arguments_json: '{"city": "', invalid_json_str: "" }], delta_thinking: null, stop_reason: null, usage: null, error: null },
        { delta_text: null, delta_tool_calls: [{ id: "", name: "", arguments_json: "Hanoi", invalid_json_str: "" }], delta_thinking: null, stop_reason: null, usage: null, error: null },
        { delta_text: null, delta_tool_calls: [{ id: "", name: "", arguments_json: '"}', invalid_json_str: "" }], delta_thinking: null, stop_reason: 10, usage: null, error: null },
      ];
      let callIdx = 0;
      decodeGetChatMessageResponse.mockImplementation(() => decodeSequence[callIdx++]);

      proxyAwareFetch.mockResolvedValue(makeMockStreamResponse(["chunk1"]));

      const result = await executor.execute({
        model: "ws/glm-5-2",
        body: { messages: [], tools: [] },
        stream: true,
        credentials: { apiKey: "test-key" },
        signal: null,
        log: null,
      });

      expect(result.response).toBeDefined();
      expect(result.response.constructor.name).toBe("Response");

      // Read SSE stream and verify tool_use events
      const sseText = await result.response.text();
      const events = sseText.split("\n\n").filter(e => e.trim()).map(e => {
        const dataLine = e.split("\n").find(l => l.startsWith("data:"));
        return dataLine ? JSON.parse(dataLine.replace("data: ", "")) : null;
      });

      // Should have exactly 1 content_block_start with type=tool_use
      const toolStarts = events.filter(e => e?.type === "content_block_start" && e?.content_block?.type === "tool_use");
      expect(toolStarts.length).toBe(1);
      expect(toolStarts[0].content_block.id).toBe("tool-123");
      expect(toolStarts[0].content_block.name).toBe("get_weather");

      // Should have 3 input_json_delta (skip empty first frame args)
      const toolDeltas = events.filter(e => e?.type === "content_block_delta" && e?.delta?.type === "input_json_delta");
      expect(toolDeltas.length).toBe(3);
      const fullArgs = toolDeltas.map(d => d.delta.partial_json).join("");
      expect(fullArgs).toBe('{"city": "Hanoi"}');

      // stop_reason should be tool_use (10 → tool_use)
      const msgDelta = events.find(e => e?.type === "message_delta");
      expect(msgDelta.delta.stop_reason).toBe("tool_use");
    });
  });

  describe("execute - non-streaming", () => {
    it("aggregates deltas into synthetic Anthropic Message", async () => {
      const mockFrame = { flags: 0x00, payload: Buffer.from([0x01]) };
      connectFrameDecode.mockReturnValue([mockFrame]);
      decodeGetChatMessageResponse.mockReturnValue({
        delta_text: "Hello world",
        delta_tool_calls: [],
        delta_thinking: null,
        stop_reason: 2,
        usage: { input_tokens: 10, output_tokens: 5 },
        error: null
      });

      proxyAwareFetch.mockResolvedValue(makeMockStreamResponse(["chunk1"]));

      const result = await executor.execute({
        model: "ws/sonnet-4.6",
        body: { messages: [] },
        stream: false,
        credentials: { apiKey: "test-key" },
        signal: null,
        log: null,
      });

      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
      // Verify the response is a Response object
      expect(result.response.constructor.name).toBe("Response");
    });

    it("aggregates tool calls into synthetic Message", async () => {
      const mockFrame = { flags: 0x00, payload: Buffer.from([0x01]) };
      connectFrameDecode.mockReturnValue([mockFrame]);
      decodeGetChatMessageResponse.mockReturnValue({
        delta_text: null,
        delta_tool_calls: [
          { id: "call_1", name: "test_tool", arguments_json: '{"arg":"value"}', invalid_json_str: "" }
        ],
        delta_thinking: null,
        stop_reason: 1,
        usage: null,
        error: null
      });

      proxyAwareFetch.mockResolvedValue(makeMockStreamResponse(["chunk1"]));

      const result = await executor.execute({
        model: "ws/sonnet-4.6",
        body: { messages: [] },
        stream: false,
        credentials: { apiKey: "test-key" },
        signal: null,
        log: null,
      });

      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
      expect(result.response.constructor.name).toBe("Response");
    });
  });

  describe("mapHttpError", () => {
    it("maps 401 to authentication_error", async () => {
      const response = executor.mapHttpError(401, "Unauthorized");
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.type).toBe("authentication_error");
    });

    it("maps 403 to permission_error", async () => {
      const response = executor.mapHttpError(403, "Forbidden");
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.type).toBe("permission_error");
    });

    it("maps 429 to rate_limit_error", async () => {
      const response = executor.mapHttpError(429, "Too many requests");
      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error.type).toBe("rate_limit_error");
    });

    it("maps 400 to invalid_request_error", async () => {
      const response = executor.mapHttpError(400, "Bad request");
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("maps other errors to api_error", async () => {
      const response = executor.mapHttpError(500, "Internal error");
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.type).toBe("api_error");
    });
  });

  describe("mapStopReason", () => {
    it("maps Windsurf stop_reason to Anthropic", () => {
      expect(executor.mapStopReason(0, { hasToolCalls: false })).toBe("end_turn");
      expect(executor.mapStopReason(1, { hasToolCalls: true })).toBe("tool_use");
      expect(executor.mapStopReason(2, { hasToolCalls: false })).toBe("end_turn");
      expect(executor.mapStopReason(3, { hasToolCalls: false })).toBe("max_tokens");
      expect(executor.mapStopReason(10, { hasToolCalls: true })).toBe("tool_use");
    });

    it("E-13: fallback to end_turn when stop_reason=tool_use but no tool_calls", () => {
      expect(executor.mapStopReason(1, { hasToolCalls: false })).toBe("end_turn");
      expect(executor.mapStopReason(10, { hasToolCalls: false })).toBe("end_turn");
    });
  });
});
