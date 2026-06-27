/**
 * Windsurf Protobuf Encoder/Decoder
 * Implements ConnectRPC protobuf wire format for Windsurf API
 */

import { randomUUID } from "crypto";
import { buildMetadata } from "./windsurfAuth.js";

const DEBUG = process.env.WINDSURF_PROTOBUF_DEBUG === "1";
const log = (tag, ...args) => DEBUG && console.log(`[WINDSURF_PROTOBUF:${tag}]`, ...args);
const textDecoder = new TextDecoder();

const WIRE_TYPE = { VARINT: 0, FIXED64: 1, LEN: 2, FIXED32: 5 };

const CHAT_MESSAGE_SOURCE = {
  UNSPECIFIED: 0,
  USER: 1,
  SYSTEM: 2,
  UNKNOWN: 3,
  TOOL: 4,
  SYSTEM_PROMPT: 5
};

const REQUEST_TYPE = { CASCADE: 5 };
const PLANNER_MODE = { DEFAULT: 1 };

// ==================== PRIMITIVE ENCODING ====================

export function encodeVarint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7F);
  return new Uint8Array(bytes);
}

export function encodeField(fieldNum, wireType, value) {
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

  if (wireType === WIRE_TYPE.FIXED64) {
    const valueBytes = new Uint8Array(8);
    const view = new DataView(valueBytes.buffer);
    if (typeof value === "bigint") {
      view.setBigUint64(0, value, true);
    } else {
      view.setFloat64(0, value, true);
    }
    return concatArrays(tagBytes, valueBytes);
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

// ==================== MESSAGE BUILDING ====================

/**
 * Build ChatMessagePrompt protobuf message
 * Maps Anthropic message to Windsurf ChatMessagePrompt
 */
function buildChatMessagePrompt(anthropicMessage) {
  const messageId = randomUUID();

  // Map Anthropic role to Windsurf source
  let source;
  if (anthropicMessage.role === "user") {
    source = CHAT_MESSAGE_SOURCE.USER;
  } else if (anthropicMessage.role === "assistant") {
    source = CHAT_MESSAGE_SOURCE.SYSTEM; // OQ13: enum has no "assistant", use SYSTEM
  } else if (anthropicMessage.role === "tool") {
    source = CHAT_MESSAGE_SOURCE.TOOL;
  } else {
    source = CHAT_MESSAGE_SOURCE.UNKNOWN;
  }

  // Extract text content from Anthropic message
  let prompt = "";
  const content = anthropicMessage.content;

  if (typeof content === "string") {
    prompt = content;
  } else if (Array.isArray(content)) {
    // Filter out image blocks (E-5: not supported for MVP)
    const textBlocks = content.filter(b => b.type === "text");
    prompt = textBlocks.map(b => b.text).join("\n");

    // Log warning if image blocks were dropped
    const hasImage = content.some(b => b.type === "image");
    if (hasImage) {
      log("WARN", "Image content blocks dropped (not supported for MVP)");
    }

    // Edge case NEW-4: if only image blocks, use placeholder
    if (textBlocks.length === 0 && hasImage) {
      prompt = "[image content not supported]";
    }
  }

  // Handle tool_result is_error (E-6)
  if (anthropicMessage.role === "tool" && anthropicMessage.is_error) {
    prompt = "[ERROR] " + prompt;
  }

  // Extract tool_call_id for tool_result messages
  const toolCallId = anthropicMessage.tool_call_id || null;

  // Build message fields
  const fields = [
    encodeField(1, WIRE_TYPE.LEN, messageId),
    encodeField(2, WIRE_TYPE.VARINT, source),
    encodeField(3, WIRE_TYPE.LEN, prompt)
  ];

  if (toolCallId) {
    fields.push(encodeField(7, WIRE_TYPE.LEN, toolCallId));
  }

  // Handle tool_calls for assistant messages (Story 2.1)
  if (anthropicMessage.role === "assistant" && Array.isArray(anthropicMessage.tool_calls)) {
    for (const toolCall of anthropicMessage.tool_calls) {
      const toolCallMsg = buildToolCall(toolCall);
      fields.push(encodeField(6, WIRE_TYPE.LEN, toolCallMsg));
    }
  }

  // Handle thinking content (Story 3.2)
  if (Array.isArray(content)) {
    const thinkingBlock = content.find(b => b.type === "thinking");
    if (thinkingBlock && thinkingBlock.thinking) {
      fields.push(encodeField(11, WIRE_TYPE.LEN, thinkingBlock.thinking));
    }
  }

  return concatArrays(...fields);
}

/**
 * Build ChatToolCall protobuf message (for assistant tool_use blocks)
 * Story 2.1: tool calls in assistant messages
 */
function buildToolCall(toolCall) {
  const id = toolCall.id || randomUUID();
  const name = toolCall.function?.name || "";
  const args = toolCall.function?.arguments || "{}";

  return concatArrays(
    encodeField(1, WIRE_TYPE.LEN, id),
    encodeField(2, WIRE_TYPE.LEN, name),
    encodeField(3, WIRE_TYPE.LEN, args)
  );
}

/**
 * Build ChatToolDefinition protobuf message
 * Maps Anthropic tool definition to Windsurf ChatToolDefinition
 */
function buildToolDefinition(anthropicTool) {
  const name = anthropicTool.name || "";
  const description = anthropicTool.description || "";
  const inputSchema = anthropicTool.input_schema || {}; // E-7: guard undefined

  return concatArrays(
    encodeField(1, WIRE_TYPE.LEN, name),
    encodeField(2, WIRE_TYPE.LEN, description),
    encodeField(3, WIRE_TYPE.LEN, JSON.stringify(inputSchema))
  );
}

/**
 * Build CompletionConfiguration protobuf message
 */
function buildConfiguration(anthropicRequest) {
  const maxTokens = anthropicRequest.max_tokens || 128000;

  // Double encoding using BigInt for precision
  // temperature = 1.0 → 0x3FF0000000000000n
  // top_p = 0.95 → 0x3FEE666666666666n

  return concatArrays(
    encodeField(1, WIRE_TYPE.VARINT, 1), // num_completions
    encodeField(2, WIRE_TYPE.VARINT, maxTokens),
    encodeField(3, WIRE_TYPE.VARINT, 400), // max_newlines
    encodeField(5, WIRE_TYPE.FIXED64, 0x3FF0000000000000n), // temperature = 1.0
    encodeField(7, WIRE_TYPE.VARINT, 40), // top_k
    encodeField(8, WIRE_TYPE.FIXED64, 0x3FEE666666666666n) // top_p = 0.95
  );
}

/**
 * Build full GetChatMessageRequest protobuf message
 * Encodes all required fields per Architecture §3.2
 */
export function buildGetChatMessageRequest(anthropicRequest, apiKey, modelUid) {
  const fields = [];

  // Field 1: Metadata
  fields.push(encodeField(1, WIRE_TYPE.LEN, buildMetadata(apiKey)));

  // Field 2: system prompt (concat system blocks)
  if (anthropicRequest.system && Array.isArray(anthropicRequest.system)) {
    const systemPrompt = anthropicRequest.system.map(b => b.text).join("\n\n");
    fields.push(encodeField(2, WIRE_TYPE.LEN, systemPrompt));
  }

  // Field 3: chat_message_prompts (repeated)
  if (anthropicRequest.messages && Array.isArray(anthropicRequest.messages)) {
    for (const msg of anthropicRequest.messages) {
      fields.push(encodeField(3, WIRE_TYPE.LEN, buildChatMessagePrompt(msg)));
    }
  }

  // Field 7: request_type = CASCADE (5)
  fields.push(encodeField(7, WIRE_TYPE.VARINT, REQUEST_TYPE.CASCADE));

  // Field 8: configuration
  fields.push(encodeField(8, WIRE_TYPE.LEN, buildConfiguration(anthropicRequest)));

  // Field 10: tools (repeated)
  if (anthropicRequest.tools && Array.isArray(anthropicRequest.tools)) {
    for (const tool of anthropicRequest.tools) {
      fields.push(encodeField(10, WIRE_TYPE.LEN, buildToolDefinition(tool)));
    }
  }

  // Field 16: cascade_id (UUID)
  fields.push(encodeField(16, WIRE_TYPE.LEN, randomUUID()));

  // Field 20: planner_mode = DEFAULT (1)
  fields.push(encodeField(20, WIRE_TYPE.VARINT, PLANNER_MODE.DEFAULT));

  // Field 21: chat_model_uid
  fields.push(encodeField(21, WIRE_TYPE.LEN, modelUid));

  // Field 22: execution_id (UUID)
  fields.push(encodeField(22, WIRE_TYPE.LEN, randomUUID()));

  return concatArrays(...fields);
}

// ==================== PRIMITIVE DECODING ====================

export function decodeVarint(buffer, offset) {
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

export function decodeField(buffer, offset) {
  if (offset >= buffer.length) return [null, null, null, offset];

  const [tag, pos1] = decodeVarint(buffer, offset);
  const fieldNum = tag >> 3;
  const wireType = tag & 0x07;

  let value;
  let pos = pos1;

  if (wireType === WIRE_TYPE.VARINT) {
    [value, pos] = decodeVarint(buffer, pos);
  } else if (wireType === WIRE_TYPE.LEN) {
    const [length, pos2] = decodeVarint(buffer, pos);
    value = buffer.slice(pos2, pos2 + length);
    pos = pos2 + length;
  } else if (wireType === WIRE_TYPE.FIXED64) {
    value = buffer.slice(pos, pos + 8);
    pos += 8;
  } else if (wireType === WIRE_TYPE.FIXED32) {
    value = buffer.slice(pos, pos + 4);
    pos += 4;
  } else {
    value = null;
  }

  return [fieldNum, wireType, value, pos];
}

export function decodeMessage(data) {
  const fields = new Map();
  let pos = 0;

  while (pos < data.length) {
    const [fieldNum, wireType, value, newPos] = decodeField(data, pos);
    if (fieldNum === null) break;

    if (!fields.has(fieldNum)) fields.set(fieldNum, []);
    fields.get(fieldNum).push({ wireType, value });
    pos = newPos;
  }

  return fields;
}

// ==================== RESPONSE DECODING ====================

/**
 * Decode GetChatMessageResponse protobuf frame
 * Extracts delta_text, delta_tool_calls, delta_thinking, stop_reason, usage, latency
 */
export function decodeGetChatMessageResponse(frame) {
  try {
    const fields = decodeMessage(frame);
    const result = {
      delta_text: null,
      delta_tool_calls: [],
      delta_thinking: null,
      stop_reason: null,
      usage: null,
      latency: null,
      error: null
    };

    // Field 3: delta_text
    if (fields.has(3)) {
      result.delta_text = textDecoder.decode(fields.get(3)[0].value);
    }

    // Field 5: stop_reason
    if (fields.has(5)) {
      result.stop_reason = fields.get(5)[0].value;
    }

    // Field 6: delta_tool_calls (repeated)
    if (fields.has(6)) {
      for (const item of fields.get(6)) {
        const toolCall = decodeToolCall(item.value);
        if (toolCall) result.delta_tool_calls.push(toolCall);
      }
    }

    // Field 7: usage (ModelUsageStats)
    if (fields.has(7)) {
      result.usage = decodeUsage(fields.get(7)[0].value);
    }

    // Field 9: delta_thinking
    if (fields.has(9)) {
      result.delta_thinking = textDecoder.decode(fields.get(9)[0].value);
    }

    // Field 12: latency (double)
    if (fields.has(12)) {
      const view = new DataView(fields.get(12)[0].value.buffer);
      result.latency = view.getFloat64(0, true);
    }

    return result;
  } catch (err) {
    log("DECODE", `Failed to decode response: ${err.message}`);
    return {
      delta_text: null,
      delta_tool_calls: [],
      delta_thinking: null,
      stop_reason: null,
      usage: null,
      latency: null,
      error: err.message
    };
  }
}

/**
 * Decode ChatToolCall protobuf message
 * Extracts id, name, arguments_json, invalid_json_str
 */
function decodeToolCall(data) {
  try {
    const fields = decodeMessage(data);
    const toolCall = {
      id: "",
      name: "",
      arguments_json: "",
      invalid_json_str: ""
    };

    if (fields.has(1)) {
      toolCall.id = textDecoder.decode(fields.get(1)[0].value);
    }

    if (fields.has(2)) {
      toolCall.name = textDecoder.decode(fields.get(2)[0].value);
    }

    if (fields.has(3)) {
      toolCall.arguments_json = textDecoder.decode(fields.get(3)[0].value);
    }

    if (fields.has(4)) {
      toolCall.invalid_json_str = textDecoder.decode(fields.get(4)[0].value);
    }

    return toolCall;
  } catch (err) {
    log("DECODE", `Failed to decode tool call: ${err.message}`);
    return null;
  }
}

/**
 * Decode ModelUsageStats protobuf message
 * Extracts input_tokens, output_tokens, cache_read_tokens, model_uid
 */
function decodeUsage(data) {
  try {
    const fields = decodeMessage(data);
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      model_uid: ""
    };

    if (fields.has(2)) {
      const [value] = decodeVarint(fields.get(2)[0].value, 0);
      usage.input_tokens = value;
    }

    if (fields.has(3)) {
      const [value] = decodeVarint(fields.get(3)[0].value, 0);
      usage.output_tokens = value;
    }

    if (fields.has(5)) {
      const [value] = decodeVarint(fields.get(5)[0].value, 0);
      usage.cache_read_tokens = value;
    }

    if (fields.has(9)) {
      usage.model_uid = textDecoder.decode(fields.get(9)[0].value);
    }

    return usage;
  } catch (err) {
    log("DECODE", `Failed to decode usage: ${err.message}`);
    return null;
  }
}

// ==================== CONNECT-RPC FRAMING ====================

// Buffer accumulation for cross-packet frames (W-H1)
let frameBuffer = Buffer.alloc(0);

/**
 * Decode Connect-RPC frames from buffer
 * Handles frame splitting across TCP packets (buffer accumulation)
 */
export function connectFrameDecode(chunk) {
  const frames = [];

  // Accumulate chunk into buffer
  frameBuffer = Buffer.concat([frameBuffer, chunk]);

  // Parse complete frames
  while (frameBuffer.length >= 5) {
    const flags = frameBuffer[0];
    const length = (frameBuffer[1] << 24) | (frameBuffer[2] << 16) | (frameBuffer[3] << 8) | frameBuffer[4];

    if (frameBuffer.length < 5 + length) {
      // Incomplete frame, wait for more data
      break;
    }

    const payload = frameBuffer.slice(5, 5 + length);
    frames.push({ flags, payload });

    // Remove parsed frame from buffer
    frameBuffer = frameBuffer.slice(5 + length);
  }

  return frames;
}

/**
 * Reset frame buffer (call when connection closes or errors)
 */
export function resetFrameBuffer() {
  frameBuffer = Buffer.alloc(0);
}

/**
 * Parse Connect-RPC end frame (flag 0x02)
 * Extracts JSON error object
 */
export function parseConnectEndFrame(frameBytes) {
  if (!frameBytes || frameBytes.length < 1) {
    return null;
  }

  const jsonStr = textDecoder.decode(frameBytes);
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed.error) {
      return {
        code: parsed.error.code,
        message: parsed.error.message
      };
    }
  } catch (err) {
    log("PARSE", `Failed to parse end frame JSON: ${err.message}`);
  }

  return null;
}

/**
 * Map Connect-RPC error code to Anthropic error type
 * Per Architecture §10 error mapping
 */
export function mapConnectErrorToAnthropic(connectError) {
  const map = {
    "unauthenticated": { status: 401, type: "authentication_error" },
    "permission_denied": { status: 403, type: "permission_error" },
    "resource_exhausted": { status: 429, type: "rate_limit_error" },
    "failed_precondition": { status: 403, type: "permission_error" },
    "invalid_argument": { status: 400, type: "invalid_request_error" },
    "internal": { status: 502, type: "api_error" },
    "unavailable": { status: 529, type: "overloaded_error" }
  };

  const { status, type } = map[connectError.code] || { status: 502, type: "api_error" };
  return {
    status,
    error: {
      type: "error",
      error: {
        type,
        message: connectError.message
      }
    }
  };
}

// ==================== DEBUG UTILITIES ====================

/**
 * Extract all strings from protobuf buffer (for debugging)
 */
export function extractStrings(buffer) {
  try {
    const fields = decodeMessage(buffer);
    const strings = [];

    for (const [fieldNum, items] of fields.entries()) {
      for (const item of items) {
        if (item.wireType === WIRE_TYPE.LEN) {
          const str = textDecoder.decode(item.value);
          strings.push(`Field ${fieldNum}: ${str}`);
        }
      }
    }

    return strings;
  } catch (err) {
    log("EXTRACT", `Failed to extract strings: ${err.message}`);
    return [];
  }
}
