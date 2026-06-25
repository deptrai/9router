/**
 * Story N.2 — AC16: WindsurfExecutor mock-fetch tests.
 * Covers: 200 stream:true, 200 stream:false, 401 bad token, 429 rate limit, JWT cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock windsurfAuth before importing executor
vi.mock("../../open-sse/utils/windsurfAuth.js", () => ({
  getCachedJwt: vi.fn().mockResolvedValue("mock-jwt-token"),
  invalidateJwt: vi.fn(),
  checkRateLimit: vi.fn().mockResolvedValue(true),
  _buildRequest: vi.fn().mockReturnValue(Buffer.from([0x00, 0x01, 0x02])),
  _streamingRequest: vi.fn(),
  extractKey: vi.fn().mockResolvedValue({ api_key: null, error: "no vscdb" }),
}));

import { WindsurfExecutor } from "../../open-sse/executors/windsurf.js";
import {
  getCachedJwt,
  checkRateLimit,
  _streamingRequest,
  invalidateJwt,
  _buildRequest,
} from "../../open-sse/utils/windsurfAuth.js";
import { connectFrameDecode, extractStrings } from "../../open-sse/utils/windsurfProtobuf.js";

const originalFetch = global.fetch;

function makeBody(overrides = {}) {
  return {
    messages: [{ role: "user", content: "Hello Windsurf" }],
    ...overrides,
  };
}

function makeCredentials(apiKey = "ws-test-key") {
  return { apiKey, providerSpecificData: {} };
}

// Build a fake Response with a ReadableStream body
function mockStreamResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
    arrayBuffer: async () => {
      const reader = stream.getReader();
      let buf = new Uint8Array(0);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const newBuf = new Uint8Array(buf.length + value.length);
        newBuf.set(buf);
        newBuf.set(value, buf.length);
        buf = newBuf;
      }
      return buf.buffer;
    },
  };
}

describe("Story N.2 — WindsurfExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WINDSURF_API_KEY;
    getCachedJwt.mockResolvedValue("mock-jwt-token");
    checkRateLimit.mockResolvedValue(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("200 stream:true → SSE chunks with content", async () => {
    // Create a simple protobuf-like frame with a string "Hello from Windsurf"
    // We mock _streamingRequest to return a Response with a body
    const { connectFrameEncode } = await import("../../open-sse/utils/windsurfProtobuf.js");
    const testString = "Hello from Windsurf";
    // Build a simple protobuf string field: field 1, type 2 (length-delimited), content = testString
    const innerProto = Buffer.alloc(2 + testString.length);
    innerProto[0] = 0x0a; // field 1, wire type 2
    innerProto[1] = testString.length;
    innerProto.write(testString, 2);
    const frame = connectFrameEncode(innerProto);

    _streamingRequest.mockResolvedValue(mockStreamResponse([frame]));

    const executor = new WindsurfExecutor("windsurf", {});
    const result = await executor.execute({
      model: "swe",
      body: makeBody(),
      stream: true,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(200);
    // Read SSE stream manually (chunks are strings, not Uint8Array)
    const reader = result.response.body.getReader();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += typeof value === "string" ? value : new TextDecoder().decode(value);
    }
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("[DONE]");
    expect(text).toContain('"finish_reason":"stop"');
  });

  it("200 stream:false → JSON body", async () => {
    const { connectFrameEncode } = await import("../../open-sse/utils/windsurfProtobuf.js");
    const testString = "Non-stream response";
    const innerProto = Buffer.alloc(2 + testString.length);
    innerProto[0] = 0x0a;
    innerProto[1] = testString.length;
    innerProto.write(testString, 2);
    const frame = connectFrameEncode(innerProto);

    _streamingRequest.mockResolvedValue(mockStreamResponse([frame]));

    const executor = new WindsurfExecutor("windsurf", {});
    const result = await executor.execute({
      model: "swe",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.choices[0].message.role).toBe("assistant");
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  it("401 bad token → synthetic 401 Response", async () => {
    const err = new Error("HTTP 401");
    err.status = 401;
    _streamingRequest.mockRejectedValue(err);

    const executor = new WindsurfExecutor("windsurf", {});
    const result = await executor.execute({
      model: "swe",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(401);
    expect(invalidateJwt).toHaveBeenCalledWith("ws-test-key");
  });

  it("429 rate limit → synthetic 429 Response", async () => {
    checkRateLimit.mockResolvedValue(false);

    const executor = new WindsurfExecutor("windsurf", {});
    const result = await executor.execute({
      model: "swe",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(429);
  });

  it("JWT fetch failure → 401", async () => {
    getCachedJwt.mockRejectedValue(new Error("JWT fetch failed"));

    const executor = new WindsurfExecutor("windsurf", {});
    const result = await executor.execute({
      model: "swe",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(401);
  });

  it("F5: credentials.apiKey takes precedence over env", async () => {
    process.env.WINDSURF_API_KEY = "env-key";
    const { connectFrameEncode } = await import("../../open-sse/utils/windsurfProtobuf.js");
    const testString = "ok";
    const innerProto = Buffer.alloc(2 + testString.length);
    innerProto[0] = 0x0a;
    innerProto[1] = testString.length;
    innerProto.write(testString, 2);
    const frame = connectFrameEncode(innerProto);
    _streamingRequest.mockResolvedValue(mockStreamResponse([frame]));

    const executor = new WindsurfExecutor("windsurf", {});
    await executor.execute({
      model: "swe",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials("db-key"),
      signal: undefined,
    });

    // getCachedJwt should be called with "db-key" (credentials), not "env-key"
    expect(getCachedJwt).toHaveBeenCalledWith("db-key");
  });

  it("F9: multimodal array content extracted to text", async () => {
    const { connectFrameEncode } = await import("../../open-sse/utils/windsurfProtobuf.js");
    const testString = "ok";
    const innerProto = Buffer.alloc(2 + testString.length);
    innerProto[0] = 0x0a;
    innerProto[1] = testString.length;
    innerProto.write(testString, 2);
    const frame = connectFrameEncode(innerProto);
    _streamingRequest.mockResolvedValue(mockStreamResponse([frame]));

    const executor = new WindsurfExecutor("windsurf", {});
    await executor.execute({
      model: "swe",
      body: makeBody({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Image description: " },
            { type: "image_url", image_url: { url: "data:..." } },
          ],
        }],
      }),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    // _buildRequest should have been called with extracted text, not array
    const callArgs = _buildRequest.mock.calls[0];
    const messages = callArgs[2]; // third arg is protoMessages
    expect(messages[0].content).toBe("Image description: ");
    expect(typeof messages[0].content).toBe("string");
  });

  it("Multi-model: resolves upstreamModelId via getModelUpstreamId", async () => {
    const { connectFrameEncode } = await import("../../open-sse/utils/windsurfProtobuf.js");
    const testString = "ok";
    const innerProto = Buffer.alloc(2 + testString.length);
    innerProto[0] = 0x0a;
    innerProto[1] = testString.length;
    innerProto.write(testString, 2);
    const frame = connectFrameEncode(innerProto);
    _streamingRequest.mockResolvedValue(mockStreamResponse([frame]));

    const executor = new WindsurfExecutor("windsurf", {});
    await executor.execute({
      model: "claude-opus-4-6",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    // _buildRequest 5th arg = model ID passed to Cascade
    const callArgs = _buildRequest.mock.calls[0];
    expect(callArgs[4]).toBe("claude-opus-4-6"); // upstreamModelId == id for this model
  });

  it("Multi-model: swe resolves to MODEL_SWE_1_6_SLOW", async () => {
    const { connectFrameEncode } = await import("../../open-sse/utils/windsurfProtobuf.js");
    const testString = "ok";
    const innerProto = Buffer.alloc(2 + testString.length);
    innerProto[0] = 0x0a;
    innerProto[1] = testString.length;
    innerProto.write(testString, 2);
    const frame = connectFrameEncode(innerProto);
    _streamingRequest.mockResolvedValue(mockStreamResponse([frame]));

    const executor = new WindsurfExecutor("windsurf", {});
    await executor.execute({
      model: "swe",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    const callArgs = _buildRequest.mock.calls[0];
    expect(callArgs[4]).toBe("MODEL_SWE_1_6_SLOW");
  });
});
