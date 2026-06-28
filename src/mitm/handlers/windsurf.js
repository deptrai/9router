/**
 * Windsurf / Devin CLI MITM handler — Phase 2 full implementation.
 *
 * Feature: `mitm-windsurf-devin-cli` (see _workspace/01-spec.md).
 *
 * Pipeline (inbound: Devin CLI → 9router):
 *   1. Split Connect-RPC frames from bodyBuffer (pure splitConnectFrames)
 *   2. Decode GetChatMessageRequest protobuf (first 0x00 frame)
 *   3. Translate to Anthropic /v1/messages request (strip client's windsurf_api_key;
 *      9router injects rotated credentials from DB)
 *   4. fetchRouter(anthropicBody, "/v1/messages", req.headers) → Anthropic SSE
 *   5. Parse each SSE event → buildGetChatMessageResponse(delta) → buildConnectFrame(0x00)
 *   6. message_stop → final stop/usage frame + end frame 0x02 (empty = success)
 *   7. error SSE event → end frame 0x02 with JSON error
 *
 * Signature: intercept(req, res, bodyBuffer, mappedModel, passthrough)
 *   mappedModel is null (server.js delegates windsurf like cursor — protobuf body
 *   can't be JSON.parse'd for extractModel). The handler extracts modelUid from
 *   protobuf field 21 and resolves the alias via getMitmAlias("windsurf") if needed.
 */
const { err: errLog } = require("../logger");
const { getMitmAlias } = require("../dbReader");
const { fetchRouter } = require("./base");
const {
  splitConnectFrames,
  decodeGetChatMessageRequest,
  buildGetChatMessageResponse,
  buildConnectFrame,
  mapConnectErrorToAnthropic,
} = require("../../../open-sse/utils/windsurfProtobuf.js");

// P3: MITM debug capture — gated by MITM_DEBUG=1 or IS_DEV.
// Captures: decoded request, anthropic body, 9router response, emitted frames.
// Files land in <DATA_DIR>/logs/mitm/windsurf-intercept-<ts>-*.json
const MITM_DEBUG = process.env.MITM_DEBUG === "1" || process.env.NODE_ENV === "development";
let _dumpCounter = 0;
function dumpIntercept(stage, payload) {
  if (!MITM_DEBUG) return;
  try {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
    const dumpDir = path.join(DATA_DIR, "logs", "mitm");
    if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
    _dumpCounter++;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dumpDir, `windsurf-intercept-${ts}-${_dumpCounter}-${stage}.json`);
    const safePayload = (typeof payload === "string" || Buffer.isBuffer(payload))
      ? payload.toString("utf8")
      : JSON.stringify(payload, null, 2);
    fs.writeFileSync(file, safePayload);
  } catch { /* never let debug crash the request */ }
}

// CHAT_MESSAGE_SOURCE values (must match windsurfProtobuf.js constants).
// Inverse of buildChatMessagePrompt's role mapping:
//   build: user→USER(1), assistant→SYSTEM(2), tool→TOOL(4)
//   decode (here): USER(1)→user, SYSTEM(2)→assistant, TOOL(4)→tool, SYSTEM_PROMPT(5)→system
const SOURCE_TO_ROLE = {
  1: "user",
  2: "assistant",
  4: "tool",
  5: "system",
};

// Inverse of WindsurfExecutor.getModelUid (open-sse/executors/windsurf.js line 53).
// Maps upstream Windsurf modelUid → 9router alias so /v1/messages routes to WindsurfExecutor.
// Keep in sync with getModelUid when adding models. Three minimax aliases (m2.1/m2.5/m2.7)
// all collapse to MODEL_MINIMAX_M2_1 outbound; inbound picks the newest (.7).
const WINDSURF_MODEL_UID_TO_ALIAS = {
  "claude-sonnet-4-6-thinking": "ws/sonnet-4.6",
  "claude-opus-4-8-medium": "ws/opus-4.8",
  "glm-5-2": "ws/glm-5-2",
  "glm-5-2-max-1m": "ws/glm-5-2",
  "swe-1-6": "ws/swe-1-6",
  "swe-1-6-fast": "ws/swe-1-6",
  "MODEL_MINIMAX_M2_1": "ws/minimax-m2.7",
};

/**
 * Resolve upstream modelUid → 9router alias. Priority:
 *   1. uiAlias (from getMitmAlias("windsurf")) — string or { modelUid: alias } map
 *   2. WINDSURF_MODEL_UID_TO_ALIAS auto-map (exact match)
 *   3. Normalize: strip "-max-*" suffix (e.g. "glm-5-2-max-1m" → "glm-5-2") then retry
 *   4. null (caller falls back to passthrough)
 */
function resolveModelAlias(modelUid, uiAlias) {
  if (uiAlias) {
    if (typeof uiAlias === "string") return uiAlias;
    if (typeof uiAlias === "object") {
      if (uiAlias[modelUid]) return uiAlias[modelUid];
      const vals = Object.values(uiAlias);
      if (vals.length > 0) return vals[0];
    }
  }
  if (WINDSURF_MODEL_UID_TO_ALIAS[modelUid]) return WINDSURF_MODEL_UID_TO_ALIAS[modelUid];
  // Normalize: strip variant suffix như "-max", "-max-1m", "-max-500k", "-fast"
  // Regex match cả 3 dạng: "-max" (cuối), "-max-1m" (có sub-suffix), "-fast" (speed variant).
  const normalized = modelUid.replace(/-(?:max(?:-\w+)?|fast)$/i, "");
  if (normalized !== modelUid && WINDSURF_MODEL_UID_TO_ALIAS[normalized]) {
    return WINDSURF_MODEL_UID_TO_ALIAS[normalized];
  }
  return null;
}

/**
 * Translate a decoded Windsurf GetChatMessageRequest into an Anthropic
 * /v1/messages request body. Strips metadata.apiKey (9router rotates its own).
 */
function translateToAnthropic(decoded, mappedModel) {
  const body = { stream: true };

  // System: prefer top-level `system` field (field 2); also pull out any
  // SYSTEM_PROMPT-source messages into the system blocks.
  const systemBlocks = [];
  if (decoded.system) {
    systemBlocks.push({ type: "text", text: decoded.system });
  }

  const messages = [];
  for (const m of decoded.messages) {
    const role = SOURCE_TO_ROLE[m.source] || "user";
    if (role === "system") {
      // Hoist system-source prompts into top-level system field (Anthropic has no
      // role=system in messages; same fix as WindsurfExecutor._hoistSystemMessages).
      if (m.prompt) systemBlocks.push({ type: "text", text: m.prompt });
      continue;
    }
    if (role === "tool") {
      // Anthropic tool_result message: content is the result text, tool_use_id required.
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId || "", content: m.prompt || "" }],
      });
      continue;
    }
    // user / assistant: text content (plus thinking for assistant, tool_calls → tool_use blocks)
    const content = [];
    if (m.thinking) content.push({ type: "thinking", thinking: m.thinking });
    if (m.prompt) content.push({ type: "text", text: m.prompt });
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        let input = {};
        try { input = JSON.parse(tc.arguments_json || tc.arguments || "{}"); } catch (e) { errLog(`[Windsurf MITM] malformed tool arguments_json: ${e.message}`); }
        content.push({ type: "tool_use", id: tc.id || "", name: tc.name || "", input });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    messages.push({ role, content });
  }

  if (systemBlocks.length > 0) body.system = systemBlocks;
  body.messages = messages;

  // Tools: Windsurf ChatToolDefinition → Anthropic tools
  if (Array.isArray(decoded.tools) && decoded.tools.length > 0) {
    body.tools = decoded.tools.map((t) => {
      let inputSchema = { type: "object", properties: {} };
      try { inputSchema = JSON.parse(t.inputSchemaStr || "{}"); } catch (e) { errLog(`[Windsurf MITM] malformed tool inputSchema: ${e.message}`); }
      return { name: t.name, description: t.description || "", input_schema: inputSchema };
    });
  }

  // max_tokens: prefer maxTokens (field 2, actual token limit) over maxNewlines * 400
  // (field 3 is a line-count heuristic, NOT a token limit — using it causes too-small
  // max_tokens which makes the model enter degenerate repetition loops).
  const cfg = decoded.configuration;
  if (cfg && cfg.maxTokens) {
    body.max_tokens = Math.min(cfg.maxTokens, 128000);
  } else if (cfg && cfg.maxNewlines) {
    body.max_tokens = Math.min(cfg.maxNewlines * 400, 128000);
  } else {
    body.max_tokens = 128000;
  }

  // P0: Forward sampling params (temperature, top_p, top_k) from decoded configuration.
  // Without this, WindsurfExecutor hardcodes temperature=1.0 / top_p=0.95 / top_k=40,
  // which causes degenerate repetition loops when Devin CLI sends low temperature
  // (e.g. temperature=0 for deterministic tool-use output).
  if (cfg) {
    if (typeof cfg.temperature === "number" && cfg.temperature > 0) body.temperature = cfg.temperature;
    if (typeof cfg.topP === "number" && cfg.topP > 0) body.top_p = cfg.topP;
    if (typeof cfg.topK === "number" && cfg.topK > 0) body.top_k = cfg.topK;
  }

  // Model: prefer mappedModel (from mitmAlias) else derive from modelUid.
  // WindsurfExecutor.getModelUid maps "ws/sonnet-4.6" → "claude-sonnet-4-6-thinking".
  // Here we go the other way: modelUid from the request is the upstream id; we need
  // a 9router model alias. If mappedModel is null (common — server.js passes null),
  // fall back to the modelUid as-is and let 9router's alias layer resolve it.
  body.model = mappedModel || decoded.modelUid || "ws/sonnet-4.6";

  return body;
}

/**
 * Parse Anthropic SSE stream and emit Connect-RPC frames to the client response.
 *
 * Anthropic SSE events handled:
 *   - content_block_start (type=tool_use → start a tool_call delta)
 *   - content_block_delta (text_delta → delta_text; input_json_delta → tool args;
 *     thinking_delta → delta_thinking)
 *   - message_delta (stop_reason, usage)
 *   - message_stop (final → emit stop frame + end frame)
 *   - error (→ end frame with JSON error)
 *   - ping (ignore)
 */
async function pipeAnthropicSseAsConnectFrames(routerRes, res) {
  res.writeHead(routerRes.status || 200, {
    "Content-Type": "application/connect+proto",
    "Connect-Protocol-Version": "1",
    "Transfer-Encoding": "chunked",
  });

  if (!routerRes.body) {
    res.end(buildConnectFrame(0x02, Buffer.from("{}"))); // empty end = success
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let endSent = false;

  // Anthropic streams tool_use input as incremental JSON string fragments across
  // multiple input_json_delta events. Accumulate per tool_use index, emit a single
  // delta_tool_calls frame when the block closes (content_block_stop).
  const toolUseState = {}; // index → { id, name, args }

  const sendEnd = (errorObj) => {
    if (endSent) return;
    endSent = true;
    const payload = errorObj ? Buffer.from(JSON.stringify({ error: errorObj })) : Buffer.from("{}");
    res.write(buildConnectFrame(0x02, payload));
  };

  // Anthropic stop_reason string → Windsurf stop_reason enum (best-effort mapping).
  // Windsurf enum values (observed): 1=stop, 2=length, 3=tool_use, ... We map the
  // common ones; unknown → 1 (stop).
  const STOP_REASON_MAP = {
    end_turn: 1,
    stop_sequence: 1,
    max_tokens: 2,
    tool_use: 3,
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines; each event has `event:` and `data:` lines.
      // Split on double newline, keep the trailing partial in the buffer.
      let idx;
      while ((idx = sseBuffer.indexOf("\n\n")) !== -1) {
        const rawEvent = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);
        processSseEvent(rawEvent);
      }
    }
    // Flush any trailing buffered event (some servers don't end with \n\n).
    if (sseBuffer.trim()) processSseEvent(sseBuffer);
  } finally {
    if (!endSent) sendEnd();
    res.end();
  }

  function processSseEvent(rawEvent) {
    let eventType = "";
    let dataStr = "";
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (!dataStr) return;

    let data;
    try { data = JSON.parse(dataStr); } catch { return; }

    switch (eventType) {
      case "content_block_start": {
        const block = data.content_block;
        if (block?.type === "tool_use") {
          const idx = data.index ?? 0;
          toolUseState[idx] = { id: block.id || "", name: block.name || "", args: "" };
        }
        break;
      }
      case "content_block_delta": {
        const delta = data.delta;
        if (!delta) break;
        if (delta.type === "text_delta") {
          const frame = buildConnectFrame(0x00, buildGetChatMessageResponse({ delta_text: delta.text }));
          res.write(frame);
        } else if (delta.type === "thinking_delta") {
          const frame = buildConnectFrame(0x00, buildGetChatMessageResponse({ delta_thinking: delta.thinking }));
          res.write(frame);
        } else if (delta.type === "input_json_delta") {
          const idx = data.index ?? 0;
          if (toolUseState[idx]) toolUseState[idx].args += delta.partial_json || "";
        }
        break;
      }
      case "content_block_stop": {
        const idx = data.index ?? 0;
        const tus = toolUseState[idx];
        if (tus) {
          // Emit accumulated tool call as one delta_tool_calls frame.
          const frame = buildConnectFrame(0x00, buildGetChatMessageResponse({
            delta_tool_calls: [{ id: tus.id, name: tus.name, arguments: tus.args || "{}" }],
          }));
          res.write(frame);
          delete toolUseState[idx];
        }
        break;
      }
      case "message_delta": {
        const delta = data.delta || {};
        const usage = data.usage || {};
        // Anthropic streams final stop_reason + usage on message_delta.
        if (delta.stop_reason || usage) {
          const stopReason = delta.stop_reason ? (STOP_REASON_MAP[delta.stop_reason] ?? 1) : null;
          const usageOut = usage.output_tokens != null ? {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_tokens: usage.cache_read_input_tokens || 0,
          } : null;
          const frame = buildConnectFrame(0x00, buildGetChatMessageResponse({
            ...(stopReason != null && { stop_reason: stopReason }),
            ...(usageOut && { usage: usageOut }),
          }));
          res.write(frame);
        }
        break;
      }
      case "message_stop": {
        // Final stop → emit end frame (empty payload = success).
        sendEnd();
        break;
      }
      case "error": {
        const e = data.error || data;
        sendEnd({
          code: mapAnthropicErrorToConnectCode(e.type),
          message: e.message || "Anthropic stream error",
        });
        break;
      }
      case "ping":
      default:
        break;
    }
  }
}

// Inverse of mapConnectErrorToAnthropic: Anthropic error type → Connect-RPC code string.
function mapAnthropicErrorToConnectCode(anthropicType) {
  const map = {
    authentication_error: "unauthenticated",
    permission_error: "permission_denied",
    rate_limit_error: "resource_exhausted",
    invalid_request_error: "invalid_argument",
    api_error: "internal",
    overloaded_error: "unavailable",
  };
  return map[anthropicType] || "internal";
}

/**
 * MITM intercept entry point — Option C (auto-map fallback + UI override).
 *
 * Resolve model theo thứ tự: mappedModel (server.js, thường null) → UI alias
 * (getMitmAlias("windsurf")) → WINDSURF_MODEL_UID_TO_ALIAS auto-map. Nếu vẫn
 * không resolve được (modelUid lạ) hoặc decode fail → passthrough raw tới
 * upstream thật (đừng crash client, để Devin CLI tự dùng account của user).
 *
 * @param {object} req - Incoming HTTP request (server.codeium.com Connect-RPC)
 * @param {object} res - Server response
 * @param {Buffer} bodyBuffer - Raw request body (1+ Connect-RPC frames)
 * @param {string|null} mappedModel - Alias from getMitmAlias (null cho windsurf)
 * @param {function} passthrough - Fallback forward raw tới upstream thật
 */
async function intercept(req, res, bodyBuffer, mappedModel, passthrough) {
  // 0. Decode protobuf một lần (cần cho cả resolve model và translate)
  let decoded = null;
  let decodeError = null;
  try {
    const frames = splitConnectFrames(bodyBuffer);
    const dataFrame = frames.find((f) => f.flags === 0x00);
    if (dataFrame) decoded = decodeGetChatMessageRequest(dataFrame.payload);
    else decodeError = new Error("No data frame (0x00) in Connect-RPC request body");
  } catch (e) { decodeError = e; }

  // P3: dump decoded request (modelUid, message count, configuration)
  dumpIntercept("01-decoded", {
    url: req.url,
    modelUid: decoded?.modelUid,
    messageCount: decoded?.messages?.length,
    configuration: decoded?.configuration,
    hasTools: Array.isArray(decoded?.tools) && decoded.tools.length > 0,
    decodeError: decodeError?.message,
  });

  // 1. Decode fail hoàn toàn → passthrough (last resort, không corrupt client)
  if (!decoded) {
    errLog(`[Windsurf MITM] decode failed: ${decodeError?.message} → passthrough`);
    return passthrough(req, res, bodyBuffer);
  }

  // 2. Resolve model: mappedModel → UI alias → auto-map
  const uiAlias = getMitmAlias("windsurf");
  const resolvedModel = mappedModel || resolveModelAlias(decoded.modelUid, uiAlias);

  // 3. Model không resolve được → passthrough (đừng crash 9router với model lạ)
  if (!resolvedModel) {
    errLog(`[Windsurf MITM] modelUid "${decoded.modelUid}" not in alias map → passthrough`);
    return passthrough(req, res, bodyBuffer);
  }

  // 4. Phase 2: translate → forward 9router → re-encode Connect-RPC frames
  try {
    const anthropicBody = translateToAnthropic(decoded, resolvedModel);

    // P3: dump translated Anthropic body (sampling params, max_tokens, model)
    dumpIntercept("02-anthropic-body", {
      model: anthropicBody.model,
      max_tokens: anthropicBody.max_tokens,
      temperature: anthropicBody.temperature,
      top_p: anthropicBody.top_p,
      top_k: anthropicBody.top_k,
      messageCount: anthropicBody.messages?.length,
      toolCount: anthropicBody.tools?.length,
      stream: anthropicBody.stream,
    });

    // 4. Forward to 9router /v1/messages (WindsurfExecutor handles rotation + upstream)
    const routerRes = await fetchRouter(anthropicBody, "/v1/messages", req.headers);

    // P3: dump 9router response status
    dumpIntercept("03-router-response", {
      status: routerRes.status,
      contentType: routerRes.headers.get("content-type"),
    });

    // 5 + 6 + 7: Re-encode Anthropic SSE → Connect-RPC frames
    if (routerRes.status !== 200) {
      const errText = await routerRes.text().catch(() => "");
      let errMsg = errText || `9router returned ${routerRes.status}`;
      let errCode = "internal";
      try {
        const parsed = JSON.parse(errText);
        if (parsed?.error?.type) errCode = mapAnthropicErrorToConnectCode(parsed.error.type);
        if (parsed?.error?.message) errMsg = parsed.error.message;
      } catch { /* keep raw text */ }
      // P1: forward HTTP status thật (was always 200 — caused client retry loop)
      res.writeHead(routerRes.status, {
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        "Transfer-Encoding": "chunked",
      });
      dumpIntercept("04-error-frame", { status: routerRes.status, errCode, errMsg });
      res.end(buildConnectFrame(0x02, Buffer.from(JSON.stringify({ error: { code: errCode, message: errMsg } }))));
      return;
    }

    await pipeAnthropicSseAsConnectFrames(routerRes, res);
  } catch (error) {
    errLog(`[Windsurf MITM] ${error.message}`);
    if (!res.headersSent) {
      // P1: use 500 for internal errors (was always 200)
      res.writeHead(500, {
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        "Transfer-Encoding": "chunked",
      });
    }
    dumpIntercept("04-exception", { message: error.message, stack: error.stack });
    res.end(buildConnectFrame(0x02, Buffer.from(JSON.stringify({
      error: { code: "internal", message: error.message },
    }))));
  }
}

module.exports = { intercept, translateToAnthropic, resolveModelAlias };
