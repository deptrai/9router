/**
 * Windsurf Auth Utilities
 * Builds Metadata protobuf and auth header for Windsurf API
 */

const { randomUUID } = require("crypto");

const WIRE_TYPE = { VARINT: 0, FIXED64: 1, LEN: 2, FIXED32: 5 };

function encodeVarint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7F);
  return new Uint8Array(bytes);
}

function encodeField(fieldNum, wireType, value) {
  const tag = (fieldNum << 3) | wireType;
  const tagBytes = encodeVarint(tag);

  if (wireType === WIRE_TYPE.VARINT) {
    const valueBytes = encodeVarint(value);
    return concatArrays(tagBytes, valueBytes);
  }

  if (wireType === WIRE_TYPE.LEN) {
    const dataBytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array ? value
      : Buffer.isBuffer(value) ? new Uint8Array(value)
      : new Uint8Array(0);

    const lengthBytes = encodeVarint(dataBytes.length);
    return concatArrays(tagBytes, lengthBytes, dataBytes);
  }

  return new Uint8Array(0);
}

function concatArrays(...arrays) {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Build Metadata protobuf message for Windsurf API
 * Fields (evidence-based from JS bundle):
 * - Field 1: ide_name = "chisel"
 * - Field 2: extension_version = "2026.8.18"
 * - Field 3: api_key (devin-session-token$<JWT>)
 * - Field 4: locale = "en"
 * - Field 5: os = "mac"
 * - Field 7: ide_version = "2026.8.18"
 * - Field 12: extension_name = "chisel"
 * - Field 31: REMOVED (optional, server ignores per Story 0.3)
 */
function buildMetadata(apiKey) {
  return concatArrays(
    encodeField(1, WIRE_TYPE.LEN, "chisel"),
    encodeField(2, WIRE_TYPE.LEN, "2026.8.18"),
    encodeField(3, WIRE_TYPE.LEN, apiKey),
    encodeField(4, WIRE_TYPE.LEN, "en"),
    encodeField(5, WIRE_TYPE.LEN, "mac"),
    encodeField(7, WIRE_TYPE.LEN, "2026.8.18"),
    encodeField(12, WIRE_TYPE.LEN, "chisel")
  );
}

/**
 * Build HTTP Authorization header for Windsurf API
 * Format: Basic <apiKey>-<apiKey> (token duplicated with dash)
 */
function buildAuthHeader(apiKey) {
  const credentials = `${apiKey}:${apiKey}`;
  const base64 = Buffer.from(credentials).toString("base64");
  return `Basic ${base64}`;
}

module.exports = { buildMetadata, buildAuthHeader };
