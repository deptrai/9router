/**
 * Unit tests for windsurfAuth.js
 * Tests Metadata protobuf encoding and auth header generation
 */

import { describe, it, expect } from "vitest";
import { buildMetadata, buildAuthHeader } from "../../open-sse/utils/windsurfAuth.js";

describe("windsurfAuth", () => {
  describe("buildMetadata", () => {
    it("encodes Metadata protobuf with correct fields", () => {
      const apiKey = "devin-session-token$test-jwt";
      const metadata = buildMetadata(apiKey);

      // Metadata should be a Uint8Array
      expect(metadata).toBeInstanceOf(Uint8Array);
      expect(metadata.length).toBeGreaterThan(0);

      // Verify it's valid protobuf by checking it starts with field 1 (ide_name)
      // Field 1, wire type LEN (2) → tag = (1 << 3) | 2 = 10 = 0x0A
      expect(metadata[0]).toBe(0x0A);
    });

    it("includes all required fields", () => {
      const apiKey = "devin-session-token$test-jwt";
      const metadata = buildMetadata(apiKey);

      // Decode to verify structure (simple varint/string parsing)
      let offset = 0;

      // Field 1: ide_name = "chisel"
      expect(metadata[offset]).toBe(0x0A); // tag for field 1, LEN
      offset++;
      const [len1, pos1] = decodeVarint(metadata, offset);
      offset = pos1;
      const ideName = new TextDecoder().decode(metadata.slice(offset, offset + len1));
      expect(ideName).toBe("chisel");
      offset += len1;

      // Field 2: extension_version = "2026.8.18"
      expect(metadata[offset]).toBe(0x12); // tag for field 2, LEN
      offset++;
      const [len2, pos2] = decodeVarint(metadata, offset);
      offset = pos2;
      const extVersion = new TextDecoder().decode(metadata.slice(offset, offset + len2));
      expect(extVersion).toBe("2026.8.18");
      offset += len2;

      // Field 3: api_key
      expect(metadata[offset]).toBe(0x1A); // tag for field 3, LEN
      offset++;
      const [len3, pos3] = decodeVarint(metadata, offset);
      offset = pos3;
      const apiKeyField = new TextDecoder().decode(metadata.slice(offset, offset + len3));
      expect(apiKeyField).toBe(apiKey);
    });

    it("does NOT include field 31 (removed per Story 0.3)", () => {
      const apiKey = "devin-session-token$test-jwt";
      const metadata = buildMetadata(apiKey);

      // Check that field 31 is not present
      // Field 31 would have tag = (31 << 3) | 2 = 250 = 0xFA
      for (let i = 0; i < metadata.length; i++) {
        if (metadata[i] === 0xFA) {
          // Check if this is actually field 31 by decoding the tag
          const [tag] = decodeVarint(metadata, i);
          const fieldNum = tag >> 3;
          if (fieldNum === 31) {
            throw new Error("Field 31 should not be present in metadata");
          }
        }
      }
    });
  });

  describe("buildAuthHeader", () => {
    it("builds Basic auth header with duplicated API key", () => {
      const apiKey = "devin-session-token$test-jwt";
      const header = buildAuthHeader(apiKey);

      expect(header).toBe("Basic ZGV2aW4tc2Vzc2lvbi10b2tlbiR0ZXN0LWp3dDpkZXZpbi1zZXNzaW9uLXRva2VuJHRlc3Qtand0");
    });

    it("handles special characters in API key", () => {
      const apiKey = "test-key-with-special-chars$123/abc";
      const header = buildAuthHeader(apiKey);

      expect(header).toMatch(/^Basic /);
      const base64Part = header.slice(6);
      const decoded = Buffer.from(base64Part, "base64").toString("utf8");
      expect(decoded).toBe(`${apiKey}:${apiKey}`);
    });

    it("handles empty API key", () => {
      const apiKey = "";
      const header = buildAuthHeader(apiKey);

      expect(header).toBe("Basic Og==");
    });
  });
});

// Helper function for varint decoding (copied from windsurfProtobuf)
function decodeVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;

  while (pos < buffer.length) {
    const b = buffer[pos];
    result |= (b & 0x7F) << shift;
    pos++;
    if (!(b & 0x80)) break;
    shift += 7;
  }

  return [result, pos];
}
