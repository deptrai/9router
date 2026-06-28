/**
 * Unit tests for windsurfProtobuf.js
 * Tests ProtobufEncoder, request building, response decoding, and Connect-RPC framing
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  encodeVarint,
  encodeField,
  buildGetChatMessageRequest,
  decodeGetChatMessageRequest,
  decodeGetChatMessageResponse,
  connectFrameDecode,
  resetFrameBuffer,
  parseConnectEndFrame,
  mapConnectErrorToAnthropic,
  extractStrings
} from "../../open-sse/utils/windsurfProtobuf.js";

describe("windsurfProtobuf", () => {
  beforeEach(() => {
    resetFrameBuffer();
  });

  describe("encodeVarint", () => {
    it("encodes small values correctly", () => {
      const encoded = encodeVarint(42);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBe(1);
      expect(encoded[0]).toBe(42);
    });

    it("encodes values >= 128 with multiple bytes", () => {
      const encoded = encodeVarint(300);
      expect(encoded.length).toBe(2);
      expect(encoded[0]).toBe(0xAC); // 300 & 0x7F | 0x80
      expect(encoded[1]).toBe(0x02);  // 300 >> 7
    });

    it("encodes zero correctly", () => {
      const encoded = encodeVarint(0);
      expect(encoded.length).toBe(1);
      expect(encoded[0]).toBe(0);
    });
  });

  describe("encodeField", () => {
    it("encodes VARINT fields", () => {
      const encoded = encodeField(1, 0, 42);
      expect(encoded[0]).toBe(0x08); // tag: (1 << 3) | 0
      expect(encoded[1]).toBe(42);
    });

    it("encodes LEN fields with string", () => {
      const encoded = encodeField(2, 2, "test");
      expect(encoded[0]).toBe(0x12); // tag: (2 << 3) | 2
      expect(encoded[1]).toBe(4);   // length
      expect(new TextDecoder().decode(encoded.slice(2))).toBe("test");
    });

    it("encodes LEN fields with Uint8Array", () => {
      const data = new Uint8Array([1, 2, 3]);
      const encoded = encodeField(3, 2, data);
      expect(encoded[0]).toBe(0x1A); // tag: (3 << 3) | 2
      expect(encoded[1]).toBe(3);   // length
      expect(encoded.slice(2)).toEqual(data);
    });

    it("encodes FIXED64 fields with BigInt", () => {
      const encoded = encodeField(5, 1, 0x3FF0000000000000n);
      expect(encoded[0]).toBe(0x29); // tag: (5 << 3) | 1 = 40 | 1 = 41 = 0x29
      expect(encoded.length).toBe(9); // 1 byte tag + 8 bytes value
    });
  });

  describe("buildGetChatMessageRequest", () => {
    it("encodes request with all required fields", () => {
      const anthropicRequest = {
        system: [{ type: "text", text: "You are a helpful assistant" }],
        messages: [
          { role: "user", content: "Hello" }
        ],
        max_tokens: 4096,
        tools: [
          { name: "test_tool", description: "A test tool", input_schema: { type: "object" } }
        ]
      };

      const apiKey = "devin-session-token$test-jwt";
      const modelUid = "claude-sonnet-4-6-thinking";

      const request = buildGetChatMessageRequest(anthropicRequest, apiKey, modelUid);

      expect(request).toBeInstanceOf(Uint8Array);
      expect(request.length).toBeGreaterThan(0);

      // Verify field 1 (Metadata) is present
      expect(request[0]).toBe(0x0A); // tag for field 1, LEN
    });

    it("handles missing system prompt", () => {
      const anthropicRequest = {
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 4096
      };

      const request = buildGetChatMessageRequest(anthropicRequest, "test-key", "test-model");
      expect(request).toBeInstanceOf(Uint8Array);
    });

    it("handles missing tools", () => {
      const anthropicRequest = {
        system: [{ type: "text", text: "You are helpful" }],
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 4096
      };

      const request = buildGetChatMessageRequest(anthropicRequest, "test-key", "test-model");
      expect(request).toBeInstanceOf(Uint8Array);
    });

    it("handles tool_result with is_error flag", () => {
      const anthropicRequest = {
        messages: [
          { role: "tool", content: "Error occurred", tool_call_id: "call-123", is_error: true }
        ],
        max_tokens: 4096
      };

      const request = buildGetChatMessageRequest(anthropicRequest, "test-key", "test-model");
      expect(request).toBeInstanceOf(Uint8Array);

      // Verify prompt contains [ERROR] prefix
      const decoded = new TextDecoder().decode(request);
      expect(decoded).toContain("[ERROR]");
    });

    it("drops image content blocks with warning", () => {
      const anthropicRequest = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this" },
              { type: "image", source: { type: "base64", data: "abc" } }
            ]
          }
        ],
        max_tokens: 4096
      };

      const request = buildGetChatMessageRequest(anthropicRequest, "test-key", "test-model");
      expect(request).toBeInstanceOf(Uint8Array);
    });

    it("uses placeholder when only image blocks present", () => {
      const anthropicRequest = {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", data: "abc" } }
            ]
          }
        ],
        max_tokens: 4096
      };

      const request = buildGetChatMessageRequest(anthropicRequest, "test-key", "test-model");
      expect(request).toBeInstanceOf(Uint8Array);

      const decoded = new TextDecoder().decode(request);
      expect(decoded).toContain("[image content not supported]");
    });

    // P2: max_newlines derived from max_tokens (was hardcoded 400)
    it("P2: max_newlines derived from max_tokens via roundtrip decode", () => {
      const anthropicRequest = {
        messages: [{ role: "user", content: "test" }],
        max_tokens: 50000, // → maxNewlines = max(400, 50000/100) = 500
      };
      const request = buildGetChatMessageRequest(anthropicRequest, "test-key", "test-model");
      const decoded = decodeGetChatMessageRequest(request);
      expect(decoded.configuration.maxTokens).toBe(50000);
      expect(decoded.configuration.maxNewlines).toBe(500); // 50000/100, not 400
    });

    it("P2: max_newlines floors at 400 for small max_tokens", () => {
      const anthropicRequest = {
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1000, // → 1000/100 = 10 → floor 400
      };
      const request = buildGetChatMessageRequest(anthropicRequest, "test-key", "test-model");
      const decoded = decodeGetChatMessageRequest(request);
      expect(decoded.configuration.maxNewlines).toBe(400);
    });

    it("P2: max_newlines caps at 100000 for huge max_tokens", () => {
      const anthropicRequest = {
        messages: [{ role: "user", content: "test" }],
        max_tokens: 20000000, // → 200000 → cap 100000
      };
      const request = buildGetChatMessageRequest(anthropicRequest, "test-key", "test-model");
      const decoded = decodeGetChatMessageRequest(request);
      expect(decoded.configuration.maxNewlines).toBe(100000);
    });

    // P0: sampling params forwarded through roundtrip
    it("P0: temperature/top_p/top_k forwarded through roundtrip", () => {
      const anthropicRequest = {
        messages: [{ role: "user", content: "test" }],
        max_tokens: 4096,
        temperature: 0.3,
        top_p: 0.8,
        top_k: 25,
      };
      const request = buildGetChatMessageRequest(anthropicRequest, "test-key", "test-model");
      const decoded = decodeGetChatMessageRequest(request);
      expect(decoded.configuration.temperature).toBeCloseTo(0.3, 5);
      expect(decoded.configuration.topP).toBeCloseTo(0.8, 5);
      expect(decoded.configuration.topK).toBe(25);
    });

    it("P0: defaults when sampling params not set", () => {
      const anthropicRequest = {
        messages: [{ role: "user", content: "test" }],
        max_tokens: 4096,
      };
      const request = buildGetChatMessageRequest(anthropicRequest, "test-key", "test-model");
      const decoded = decodeGetChatMessageRequest(request);
      expect(decoded.configuration.temperature).toBeCloseTo(1.0, 5);
      expect(decoded.configuration.topP).toBeCloseTo(0.95, 5);
      expect(decoded.configuration.topK).toBe(40);
    });
  });

  describe("decodeGetChatMessageResponse", () => {
    it("decodes delta_text field", () => {
      // Build a simple response with field 3 (delta_text)
      const response = new Uint8Array([
        0x1A, 0x05, // tag for field 3, LEN, length 5
        0x48, 0x65, 0x6C, 0x6C, 0x6F // "Hello"
      ]);

      const decoded = decodeGetChatMessageResponse(response);
      expect(decoded.delta_text).toBe("Hello");
      expect(decoded.delta_tool_calls).toEqual([]);
    });

    it("decodes stop_reason field", () => {
      const response = new Uint8Array([
        0x28, 0x02 // tag for field 5, VARINT, value 2
      ]);

      const decoded = decodeGetChatMessageResponse(response);
      expect(decoded.stop_reason).toBe(2);
    });

    it("decodes delta_tool_calls field", () => {
      // Build response with field 6 containing a tool call
      const toolCallData = new Uint8Array([
        0x0A, 0x03, // field 1, LEN, length 3 (id)
        0x69, 0x64, 0x31, // "id1"
        0x12, 0x04, // field 2, LEN, length 4 (name)
        0x74, 0x65, 0x73, 0x74, // "test"
        0x1A, 0x02, // field 3, LEN, length 2 (args)
        0x7B, 0x7D // "{}"
      ]);

      const response = new Uint8Array([
        0x32, toolCallData.length, // tag for field 6, LEN, length
        ...toolCallData
      ]);

      const decoded = decodeGetChatMessageResponse(response);
      expect(decoded.delta_tool_calls).toHaveLength(1);
      expect(decoded.delta_tool_calls[0].id).toBe("id1");
      expect(decoded.delta_tool_calls[0].name).toBe("test");
      expect(decoded.delta_tool_calls[0].arguments_json).toBe("{}");
    });

    it("decodes delta_thinking field", () => {
      const response = new Uint8Array([
        0x4A, 0x06, // tag for field 9, LEN, length 6
        0x74, 0x68, 0x69, 0x6E, 0x6B, 0x69 // "thinki"
      ]);

      const decoded = decodeGetChatMessageResponse(response);
      expect(decoded.delta_thinking).toBe("thinki");
    });

    it("handles malformed protobuf gracefully", () => {
      const response = new Uint8Array([0xFF, 0xFF, 0xFF]); // Invalid protobuf

      const decoded = decodeGetChatMessageResponse(response);
      expect(decoded.delta_text).toBeNull();
      expect(decoded.error).toBeDefined();
    });
  });

  describe("connectFrameDecode", () => {
    it("decodes single complete frame", () => {
      const payload = Buffer.from([1, 2, 3]);
      const frame = Buffer.from([
        0x00, // flags
        0x00, 0x00, 0x00, 0x03, // length (BE)
        ...payload
      ]);

      const frames = connectFrameDecode(frame);
      expect(frames).toHaveLength(1);
      expect(frames[0].flags).toBe(0x00);
      expect(frames[0].payload).toEqual(payload);
    });

    it("accumulates incomplete frames", () => {
      const payload = Buffer.from([1, 2, 3, 4, 5]);

      // Send first chunk (incomplete)
      const chunk1 = Buffer.from([
        0x00, // flags
        0x00, 0x00, 0x00, 0x05, // length
        0x01, 0x02 // partial payload
      ]);

      const frames1 = connectFrameDecode(chunk1);
      expect(frames1).toHaveLength(0); // No complete frame yet

      // Send second chunk (complete)
      const chunk2 = Buffer.from([0x03, 0x04, 0x05]);
      const frames2 = connectFrameDecode(chunk2);
      expect(frames2).toHaveLength(1);
      expect(frames2[0].payload).toEqual(payload);
    });

    it("handles multiple frames in one chunk", () => {
      const payload1 = Buffer.from([1, 2]);
      const payload2 = Buffer.from([3, 4]);

      const chunk = Buffer.from([
        0x00, 0x00, 0x00, 0x00, 0x02, ...payload1, // frame 1
        0x00, 0x00, 0x00, 0x00, 0x02, ...payload2  // frame 2
      ]);

      const frames = connectFrameDecode(chunk);
      expect(frames).toHaveLength(2);
      expect(frames[0].payload).toEqual(payload1);
      expect(frames[1].payload).toEqual(payload2);
    });

    it("resets buffer correctly", () => {
      resetFrameBuffer();
      const chunk = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x42]);
      connectFrameDecode(chunk);
      resetFrameBuffer();

      // Buffer should be empty after reset
      const chunk2 = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x43]);
      const frames = connectFrameDecode(chunk2);
      expect(frames).toHaveLength(1);
      expect(frames[0].payload[0]).toBe(0x43);
    });
  });

  describe("parseConnectEndFrame", () => {
    it("parses valid end frame payload with error", () => {
      const errorJson = JSON.stringify({
        error: {
          code: "failed_precondition",
          message: "Quota exhausted"
        }
      });

      const payload = new TextEncoder().encode(errorJson);

      const parsed = parseConnectEndFrame(payload);
      expect(parsed).not.toBeNull();
      expect(parsed.code).toBe("failed_precondition");
      expect(parsed.message).toBe("Quota exhausted");
    });

    it("returns null for empty payload", () => {
      const parsed = parseConnectEndFrame(new Uint8Array(0));
      expect(parsed).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      const payload = new TextEncoder().encode("invalid");
      const parsed = parseConnectEndFrame(payload);
      expect(parsed).toBeNull();
    });

    it("returns null for JSON without error field", () => {
      const payload = new TextEncoder().encode(JSON.stringify({ ok: true }));
      const parsed = parseConnectEndFrame(payload);
      expect(parsed).toBeNull();
    });
  });

  describe("mapConnectErrorToAnthropic", () => {
    it("maps unauthenticated to 401 authentication_error", () => {
      const connectError = { code: "unauthenticated", message: "Invalid credentials" };
      const mapped = mapConnectErrorToAnthropic(connectError);

      expect(mapped.status).toBe(401);
      expect(mapped.error.error.type).toBe("authentication_error");
    });

    it("maps permission_denied to 403 permission_error", () => {
      const connectError = { code: "permission_denied", message: "Access denied" };
      const mapped = mapConnectErrorToAnthropic(connectError);

      expect(mapped.status).toBe(403);
      expect(mapped.error.error.type).toBe("permission_error");
    });

    it("maps resource_exhausted to 429 rate_limit_error", () => {
      const connectError = { code: "resource_exhausted", message: "Rate limit exceeded" };
      const mapped = mapConnectErrorToAnthropic(connectError);

      expect(mapped.status).toBe(429);
      expect(mapped.error.error.type).toBe("rate_limit_error");
    });

    it("maps failed_precondition to 403 permission_error", () => {
      const connectError = { code: "failed_precondition", message: "Quota exhausted" };
      const mapped = mapConnectErrorToAnthropic(connectError);

      expect(mapped.status).toBe(403);
      expect(mapped.error.error.type).toBe("permission_error");
    });

    it("maps invalid_argument to 400 invalid_request_error", () => {
      const connectError = { code: "invalid_argument", message: "Invalid request" };
      const mapped = mapConnectErrorToAnthropic(connectError);

      expect(mapped.status).toBe(400);
      expect(mapped.error.error.type).toBe("invalid_request_error");
    });

    it("maps internal to 502 api_error", () => {
      const connectError = { code: "internal", message: "Internal server error" };
      const mapped = mapConnectErrorToAnthropic(connectError);

      expect(mapped.status).toBe(502);
      expect(mapped.error.error.type).toBe("api_error");
    });

    it("maps unavailable to 529 overloaded_error", () => {
      const connectError = { code: "unavailable", message: "Service overloaded" };
      const mapped = mapConnectErrorToAnthropic(connectError);

      expect(mapped.status).toBe(529);
      expect(mapped.error.error.type).toBe("overloaded_error");
    });

    it("maps unknown error to 502 api_error", () => {
      const connectError = { code: "unknown_error", message: "Something went wrong" };
      const mapped = mapConnectErrorToAnthropic(connectError);

      expect(mapped.status).toBe(502);
      expect(mapped.error.error.type).toBe("api_error");
    });
  });

  describe("extractStrings", () => {
    it("extracts string fields from protobuf", () => {
      const proto = new Uint8Array([
        0x0A, 0x05, 0x48, 0x65, 0x6C, 0x6C, 0x6F, // field 1: "Hello"
        0x12, 0x06, 0x57, 0x6F, 0x72, 0x6C, 0x64, 0x21 // field 2: "World!"
      ]);

      const strings = extractStrings(proto);
      expect(strings).toHaveLength(2);
      expect(strings[0]).toContain("Hello");
      expect(strings[1]).toContain("World!");
    });

    it("handles empty protobuf", () => {
      const strings = extractStrings(new Uint8Array([]));
      expect(strings).toEqual([]);
    });

    it("handles malformed protobuf gracefully", () => {
      const strings = extractStrings(new Uint8Array([0xFF, 0xFF]));
      expect(strings).toEqual([]);
    });
  });
});
