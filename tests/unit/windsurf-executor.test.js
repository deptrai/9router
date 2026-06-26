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
      model: "swe-1-6",
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
      model: "swe-1-6",
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
      model: "swe-1-6",
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
      model: "swe-1-6",
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
      model: "swe-1-6",
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
      model: "swe-1-6",
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
      model: "swe-1-6",
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

  it("Multi-model: swe-1-6 resolves to swe-1-6 upstream", async () => {
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
      model: "swe-1-6",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    const callArgs = _buildRequest.mock.calls[0];
    expect(callArgs[4]).toBe("swe-1-6");
  });

  it("GLM model with tools: injects [TOOL_CALLS] format instruction into system message", async () => {
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
      model: "glm-5-2",
      body: makeBody({
        messages: [{ role: "user", content: "Read /tmp/foo.txt" }],
        tools: [
          { function: { name: "Read", description: "Read file", parameters: {} } },
          { function: { name: "Bash", description: "Run command", parameters: {} } },
        ],
      }),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    const callArgs = _buildRequest.mock.calls[0];
    const messages = callArgs[2];
    // System message with instruction should be prepended (index 0)
    expect(messages[0].role).toBe(5); // system role
    expect(messages[0].content).toContain("[TOOL_CALLS]");
    expect(messages[0].content).toContain("Read");
    expect(messages[0].content).toContain("Bash");
  });

  it("GLM model with tools: prepends instruction to existing system message", async () => {
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
      model: "glm-5-2",
      body: makeBody({
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Do something" },
        ],
        tools: [{ function: { name: "Read", description: "Read", parameters: {} } }],
      }),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    const callArgs = _buildRequest.mock.calls[0];
    const messages = callArgs[2];
    expect(messages[0].role).toBe(5);
    expect(messages[0].content).toContain("[TOOL_CALLS]");
    expect(messages[0].content).toContain("You are helpful.");
  });

  it("Non-GLM model with tools: does NOT inject inline-format instruction", async () => {
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
      body: makeBody({
        messages: [{ role: "user", content: "Read /tmp/foo.txt" }],
        tools: [{ function: { name: "Read", description: "Read", parameters: {} } }],
      }),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    const callArgs = _buildRequest.mock.calls[0];
    const messages = callArgs[2];
    // No system message injected — only the user message
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Read /tmp/foo.txt");
  });

  it("GLM model without tools: does NOT inject instruction", async () => {
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
      model: "glm-5-2",
      body: makeBody({ messages: [{ role: "user", content: "Hello" }] }),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    const callArgs = _buildRequest.mock.calls[0];
    const messages = callArgs[2];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello");
  });

  it("Multi-turn: tool_use and tool_result blocks converted to text for GLM context", async () => {
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
      model: "glm-5-2",
      body: makeBody({
        messages: [
          { role: "user", content: "Read /tmp/foo.txt" },
          { role: "assistant", content: [
            { type: "text", text: "Let me read that." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/foo.txt" } },
          ]},
          { role: "user", content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "file contents here" },
          ]},
        ],
        tools: [{ function: { name: "Read", description: "Read", parameters: {} } }],
      }),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    const callArgs = _buildRequest.mock.calls[0];
    const messages = callArgs[2];
    // Assistant message should contain [TOOL_CALLS] inline representation
    const assistantMsg = messages.find(m => m.role === 2);
    expect(assistantMsg.content).toContain("[TOOL_CALLS]Read[TOOL_CALLS]");
    expect(assistantMsg.content).toContain('"file_path":"/tmp/foo.txt"');
    // Tool result message should contain the result text
    const toolResultMsg = messages.find(m =>
      m.content && m.content.includes("[Tool Result for toolu_1]"));
    expect(toolResultMsg).toBeTruthy();
    expect(toolResultMsg.content).toContain("file contents here");
  });
});
