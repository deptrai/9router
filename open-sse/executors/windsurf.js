/**
 * WindsurfExecutor — OpenAI-compatible executor for Windsurf SWE LLM (Cascade WS).
 *
 * Protocol: Connect-RPC/Protobuf over HTTPS to server.self-serve.windsurf.com
 * Auth: JWT from fetchJwt(apiKey) with caching
 * Output: Re-wrap protobuf stream as OpenAI SSE chunks
 *
 * WARNING: format 'windsurf' = executor owns format. Do NOT add response translator (F2).
 * If translator is added, passthrough will break.
 */

import { randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import {
  getCachedJwt,
  invalidateJwt,
  checkRateLimit,
  _buildRequest,
  _streamingRequest,
  extractKey,
} from "../utils/windsurfAuth.js";
import {
  connectFrameDecode,
  extractStrings,
} from "../utils/windsurfProtobuf.js";
import { getModelUpstreamId } from "../config/providerModels.js";

export class WindsurfExecutor extends BaseExecutor {
  constructor(provider, config) {
    super(provider, config);
    this.provider = provider;
    this.config = config;
  }

  /**
   * Override execute() completely — do NOT call super.execute() (F5).
   * Returns synthetic Response with OpenAI-format body (F1).
   */
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    // F5: credentials.apiKey first, then env, then auto-extract
    let apiKey = credentials?.apiKey || process.env.WINDSURF_API_KEY;
    if (!apiKey) {
      const extracted = await extractKey();
      if (extracted.api_key) {
        apiKey = extracted.api_key;
        log?.debug?.("WINDSURF", "Auto-extracted token from state.vscdb");
      } else {
        return this._errorResponse(401, "WINDSURF_API_KEY not set and auto-extract failed: " + (extracted.error || "unknown"));
      }
    }

    // Get cached JWT (with F15 invalidation on 401)
    let jwt;
    try {
      jwt = await getCachedJwt(apiKey);
    } catch (e) {
      return this._errorResponse(401, `Windsurf JWT fetch failed: ${e.message}`);
    }

    // Check rate limit
    let rateLimitOk;
    try {
      rateLimitOk = await checkRateLimit(apiKey, jwt);
    } catch (e) {
      // F15: Invalidate JWT on 401 from rate-limit check
      if (e.status === 401) {
        invalidateJwt(apiKey);
        return this._errorResponse(401, "Windsurf token invalid or expired");
      }
      rateLimitOk = true; // fail-open on network errors (pre-existing pattern)
    }
    if (!rateLimitOk) {
      return this._errorResponse(429, "Windsurf rate limit exceeded");
    }

    // D3: Build tool definitions if present
    const toolDefs = body.tools && body.tools.length > 0
      ? body.tools.map(t => {
          const fn = t.function || t;
          return { name: fn.name, description: fn.description || "", schema: fn.parameters || {} };
        })
      : null;

    // DEBUG: capture raw request BEFORE any transformation
    try {
      const fs = await import("node:fs");
      const pathMod = await import("node:path");
      const logDir = "/app/data/debug";
      fs.mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const logFile = pathMod.join(logDir, `windsurf-req-${ts}.json`);
      fs.writeFileSync(logFile, JSON.stringify({
        timestamp: ts,
        model,
        stream,
        rawMessages: body.messages?.map((m, i) => ({
          idx: i,
          role: m.role,
          contentPreview: typeof m.content === "string" ? m.content.slice(0, 500) : JSON.stringify(m.content).slice(0, 500),
          contentLength: typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length,
        })),
        systemPreview: typeof body.system === "string" ? body.system.slice(0, 500) : JSON.stringify(body.system || "").slice(0, 500),
        systemLength: typeof body.system === "string" ? body.system.length : JSON.stringify(body.system || "").length,
        toolsCount: body.tools?.length || 0,
        toolsNames: body.tools?.map(t => (t.function || t).name).slice(0, 20),
      }, null, 2));
    } catch (e) { /* debug best-effort */ }

    // F23: Inject tool-call instruction for ALL models via windsurf.
    // Windsurf's GetDevstralStream API has no native tool_call field in the
    // response — tool calls must be emitted as inline text. The OLD format
    // [TOOL_CALLS]name[TOOL_CALLS]{json} was unreliable: GLM-5.2 substitutes
    // [ARGS] for the second marker, adds preamble text, and omits the second
    // tool call in a chain. The NEW format uses XML-tagged JSON blocks
    // (proven by WindsurfPoolAPI): <tool_call>{"name":"...","arguments":{...}}</tool_call>
    // GLM-5.2 follows this format perfectly — both simple and complex tasks,
    // multi-tool chaining, and large content (1774+ chars) all work correctly.
    let messagesForProto = body.messages;
    if (toolDefs) {
      // MINIMAL format instruction — inject into SYSTEM, not user message.
      // Previous approach: injected full tool list (260KB) into last user
      // message → buried user's actual message → model hallucinated.
      // New approach: short format-only instruction in system message.
      // Tool definitions passed via protobuf field 4 (toolDefs).
      const formatInstruction = [
        ``,
        `--- Tool Call Format ---`,
        `To call a function, emit: <tool_call>{"name":"<function_name>","arguments":{...}}</tool_call>`,
        `Only call functions when the user explicitly requests an action.`,
        `For greetings or questions, respond normally without tools.`,
        `Do NOT generate fake "User:" or "Assistant:" lines.`,
        `Available functions: ${toolDefs.map(t => {
          const params = t.schema?.properties ? Object.keys(t.schema.properties) : [];
          return params.length > 0 ? `${t.name}(${params.join(", ")})` : t.name;
        }).join(", ")}`,
        `--- End Tool Call Format ---`,
        ``,
      ].join("\n");

      if (messagesForProto.length > 0 && messagesForProto[0].role === "system") {
        messagesForProto = messagesForProto.map((m, i) =>
          i === 0 ? { ...m, content: m.content + "\n" + formatInstruction } : m
        );
      } else {
        messagesForProto = [{ role: "system", content: formatInstruction }, ...messagesForProto];
      }
    }

    // F9: Convert}

    // F9: Convert OpenAI messages[] to protobuf messages (extract text from multimodal)
    // D3: Include tool messages
    // F21: Pass model to _extractTextContent so non-GLM models (Sonnet, Claude,
    // GPT) get a neutral text format for tool_use blocks instead of [TOOL_CALLS]
    // marker. Sonnet 4.6 sees [TOOL_CALLS] in context and mimics the format →
    // emits inline [TOOL_CALLS]Explore[ARGS]... instead of native tool_use →
    // end_turn → session stop (session 38f24236).
    const isGlm = /glm/i.test(model);
    const protoMessages = messagesForProto.map((m) => ({
      role: m.role === "user" ? 1 : m.role === "assistant" ? 2 : m.role === "tool" ? 5 : 5,
      content: this._extractTextContent(m.content, isGlm),
      opts: {},
    }));

    // Build protobuf request — resolve user-facing model ID to Cascade upstream ID
    // F20: _buildRequest writes toolDefs via writeString (expects string), so
    // serialize the array of {name,description,schema} objects to JSON first.
    // Passing the raw array → Buffer.from(array, "utf-8") → null bytes →
    // windsurf receives empty toolDefs → model doesn't see tools natively.
    const upstreamModel = getModelUpstreamId("windsurf", model);
    const toolDefsJson = toolDefs ? JSON.stringify(toolDefs) : null;
    const protoBytes = _buildRequest(apiKey, jwt, protoMessages, toolDefsJson, upstreamModel);

    const upstreamUrl = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService/GetDevstralStream";
    const upstreamHeaders = {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
    };
    const completionId = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24); // F28: unique ID
    // Pipeline expects binary chunks (TextDecoder.decode in stream.js); encode strings to Uint8Array.
    const enc = (s) => new TextEncoder().encode(s);

    if (stream) {
      // D1: True streaming — read Response body incrementally
      const self = this;
      const streamController = new ReadableStream({
        async start(controller) {
          let resp;
          try {
            // F7: Forward signal to upstream
            resp = await _streamingRequest(protoBytes, 120000, 2, signal);
          } catch (e) {
            // F15: Invalidate JWT on 401
            if (e.status === 401) {
              invalidateJwt(apiKey);
              controller.enqueue(Buffer.from("data: " + JSON.stringify(self._errorChunk(completionId, model, 401, "Windsurf token invalid")) + "\n\n"));
            } else if (e.status === 429) {
              controller.enqueue(Buffer.from("data: " + JSON.stringify(self._errorChunk(completionId, model, 429, "Windsurf rate limit exceeded")) + "\n\n"));
            } else {
              controller.enqueue(Buffer.from("data: " + JSON.stringify(self._errorChunk(completionId, model, 502, e.message)) + "\n\n"));
            }
            // F17: Emit finish_reason on error
            controller.enqueue(Buffer.from("data: " + JSON.stringify(self._finalChunk(completionId, model, "stop")) + "\n\n"));
            controller.enqueue(Buffer.from("data: [DONE]\n\n"));
            controller.close();
            return;
          }

          try {
            // D1: Incremental stream reading
            const reader = resp.body.getReader();
            let buffer = new Uint8Array(0);
            // DEBUG: accumulate full stream text for logging
            let streamFullText = "";

            while (true) {
              if (signal?.aborted) {
                reader.cancel();
                controller.enqueue(Buffer.from("data: " + JSON.stringify(self._finalChunk(completionId, model, "stop")) + "\n\n"));
                controller.enqueue(Buffer.from("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              const { done, value } = await reader.read();
              if (done) break;

              // Append to buffer and decode complete frames
              const newBuffer = new Uint8Array(buffer.length + value.length);
            newBuffer.set(buffer);
            newBuffer.set(value, buffer.length);
            buffer = newBuffer;

              const frames = connectFrameDecode(Buffer.from(buffer));
              if (frames.length > 0) {
                // Reset buffer to remaining bytes (after last complete frame)
                // For simplicity, consume all frames and clear buffer
                buffer = new Uint8Array(0);

                for (const frame of frames) {
                  const strings = extractStrings(frame);
                  for (const text of strings) {
                    const cleaned = self._stripStopTokens(text);
                    if (!cleaned) continue;
                    streamFullText += cleaned; // DEBUG: accumulate
                    const chunk = {
                      id: completionId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      choices: [{
                        index: 0,
                        delta: { content: cleaned },
                        finish_reason: null,
                      }],
                    };
                    controller.enqueue(Buffer.from("data: " + JSON.stringify(chunk) + "\n\n"));
                  }
                }
              }
            }

            // Process any remaining buffer
            if (buffer.length > 0) {
              const frames = connectFrameDecode(Buffer.from(buffer));
              for (const frame of frames) {
                const strings = extractStrings(frame);
                for (const text of strings) {
                  const cleaned = self._stripStopTokens(text);
                  if (!cleaned) continue;
                  const chunk = {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                      index: 0,
                      delta: { content: cleaned },
                      finish_reason: null,
                    }],
                  };
                  controller.enqueue(Buffer.from("data: " + JSON.stringify(chunk) + "\n\n"));
                }
              }
            }

            // Final chunk with finish_reason
            controller.enqueue(Buffer.from("data: " + JSON.stringify(self._finalChunk(completionId, model, "stop")) + "\n\n"));
            controller.enqueue(Buffer.from("data: [DONE]\n\n"));
            controller.close();

            // DEBUG: log accumulated stream text
            try {
              const fs = await import("node:fs");
              const pathMod = await import("node:path");
              const logDir = "/app/data/debug";
              fs.mkdirSync(logDir, { recursive: true });
              const ts = new Date().toISOString().replace(/[:.]/g, "-");
              const logFile = pathMod.join(logDir, `windsurf-raw-stream-${ts}.json`);
              fs.writeFileSync(logFile, JSON.stringify({
                timestamp: ts,
                model,
                stream: true,
                toolDefsCount: toolDefs?.length || 0,
                toolDefsNames: toolDefs?.map(t => t.name) || [],
                messagesCount: messagesForProto.length,
                allMessages: messagesForProto.map((m, i) => ({
                  idx: i,
                  role: m.role,
                  contentPreview: (m.content || "").slice(0, 300),
                  contentLength: (m.content || "").length,
                })),
                lastUserContent: messagesForProto[messagesForProto.length - 1]?.content?.slice(0, 500),
                rawResponse: streamFullText,
              }, null, 2));
            } catch (e) { /* debug logging best-effort */ }
          } catch (e) {
            // F17: Emit finish_reason on mid-stream error
            if (e.status === 401) invalidateJwt(apiKey);
            controller.enqueue(Buffer.from("data: " + JSON.stringify(self._errorChunk(completionId, model, e.status || 502, e.message)) + "\n\n"));
            controller.enqueue(Buffer.from("data: " + JSON.stringify(self._finalChunk(completionId, model, "stop")) + "\n\n"));
            controller.enqueue(Buffer.from("data: [DONE]\n\n"));
            controller.close();
          }
        },
      });

      const response = new Response(streamController, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });

      return { response, url: upstreamUrl, headers: upstreamHeaders, transformedBody: { protoBytes: true } }; // F31: actual upstream body marker
    } else {
      // stream: false → buffer entire stream → JSON
      try {
        // F7: Forward signal
        const resp = await _streamingRequest(protoBytes, 120000, 2, signal);
        const arrayBuf = await resp.arrayBuffer();
        const frames = connectFrameDecode(Buffer.from(arrayBuf));
        let fullText = "";
        for (const frame of frames) {
          const strings = extractStrings(frame);
          fullText += strings.join("");
        }
        fullText = this._stripStopTokens(fullText);

        // DEBUG: log raw windsurf response to identify tool-call format issues
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const logDir = "/app/data/debug";
          fs.mkdirSync(logDir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const logFile = path.join(logDir, `windsurf-raw-${ts}.json`);
          fs.writeFileSync(logFile, JSON.stringify({
            timestamp: ts,
            model,
            toolDefsCount: toolDefs?.length || 0,
            toolDefsNames: toolDefs?.map(t => t.name) || [],
            messagesCount: messagesForProto.length,
            lastUserContent: messagesForProto[messagesForProto.length - 1]?.content?.slice(0, 500),
            rawResponse: fullText,
          }, null, 2));
        } catch (e) { /* debug logging best-effort */ }

        const jsonBody = {
          id: completionId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: fullText,
            },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        };

        const response = new Response(JSON.stringify(jsonBody), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        });

        return { response, url: upstreamUrl, headers: upstreamHeaders, transformedBody: { protoBytes: true } };
      } catch (e) {
        if (e.status === 401) {
          invalidateJwt(apiKey); // F15
          return this._errorResponse(401, "Windsurf token invalid or expired");
        }
        if (e.status === 429) {
          return this._errorResponse(429, "Windsurf rate limit exceeded");
        }
        return this._errorResponse(502, `Windsurf request failed: ${e.message}`);
      }
    }
  }

  /**
   * Create synthetic error Response with correct HTTP status (F10).
   */
  _errorResponse(status, message) {
    const errorBody = JSON.stringify({
      error: { message, type: "upstream_error", code: status },
    });
    return {
      response: new Response(errorBody, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
      url: "",
      headers: {},
      transformedBody: {},
    };
  }

  /**
   * Error chunk for SSE stream (F17).
   */
  _errorChunk(id, model, code, message) {
    return {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { content: `[Error: ${message}]` },
        finish_reason: null,
      }],
    };
  }

  /**
   * Final chunk with finish_reason (F17).
   */
  _finalChunk(id, model, finishReason) {
    return {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: finishReason,
      }],
    };
  }

  /**
   * Build tool-call instruction for the NEW XML-tagged JSON format.
   * Uses XML-style tags as delimiters with a self-describing JSON body.
   * Proven by WindsurfPoolAPI — GLM-5.2 follows this format perfectly.
   */
  _buildToolInstruction(toolDefs) {
    const TC_OPEN = "<tool_call>";
    const TC_CLOSE = "</tool_call>";
    const lines = [
      `You have access to the following functions. To invoke a function, emit a block in this EXACT format:`,
      ``,
      `${TC_OPEN}{"name":"<function_name>","arguments":{...}}${TC_CLOSE}`,
      ``,
      `Rules:`,
      `1. Each ${TC_OPEN}...${TC_CLOSE} block must fit on ONE line (no line breaks inside the JSON).`,
      `2. "arguments" must be a JSON object matching the function's parameter schema.`,
      `3. You MAY emit MULTIPLE ${TC_OPEN} blocks if the request requires calling several functions in parallel. Emit ALL needed calls consecutively, then STOP generating.`,
      `4. After emitting the last ${TC_OPEN} block, STOP. Do not write any explanation after it. The caller executes all functions and returns results as <tool_result tool_call_id="...">...</tool_result> in the next user turn.`,
      `5. ONLY call a function when the user's request EXPLICITLY requires it (e.g. "read file X", "run command Y", "search for Z"). For greetings, simple questions, or conversational messages, just respond normally WITHOUT calling any function.`,
      `6. Do NOT generate fake "User:" or "Assistant:" lines — respond directly to the user's actual message.`,
      `7. For the Bash tool: the shell is zsh, NOT bash. ALWAYS quote glob patterns.`,
      ``,
      `Available functions (${toolDefs.length} total — name: short description):`,
    ];
    // COMPACT: name + parameter names + first line of description.
    // Full JSON schemas (260KB for 179 tools) overwhelm the model and bury
    // the user's actual message. Parameter names give the model enough info
    // to construct correct arguments without the full schema overhead.
    for (const t of toolDefs) {
      const desc = (t.description || "").split("\n")[0].slice(0, 80);
      const params = t.schema?.properties ? Object.keys(t.schema.properties) : [];
      const paramStr = params.length > 0 ? `(${params.join(", ")})` : "";
      lines.push(`- ${t.name}${paramStr}: ${desc}`);
    }
    lines.push("");
    lines.push(`Respond to the user's actual message. Only use ${TC_OPEN} if the user explicitly asks for something that requires a tool.`);
    return lines.join("\n");
  }

  /**
   * Strip model EOS stop tokens from response text.
   * Windsurf's Devstral model appends </s> as end-of-sequence token.
   * @param {string} text
   * @returns {string}
   */
  _stripStopTokens(text) {
    return text
      .replace(/<\/s>\s*$/, "")         // Windsurf / Mistral / LLaMA EOS
      .replace(/<\|end\|>\s*$/, "")     // some instruction-tuned models
      .replace(/<\|endoftext\|>\s*$/, "") // GPT-2 style
      .replace(/<\|eot_id\|>\s*$/, ""); // LLaMA-3 style
  }

  /**
   * Extract text from content — string or array with multimodal parts (F9).
   * Converts Anthropic tool_use and tool_result blocks into text using the
   * NEW XML-tagged JSON format so multi-turn agent flows work: the model needs
   * to see the tool call it made and the result returned, otherwise it
   * re-calls the same tool in a loop.
   */
  _extractTextContent(content, isGlm = true) {
    const TC_OPEN = "<tool_call>";
    const TC_CLOSE = "</tool_call>";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content.map(item => {
        if (item.type === "text") return item.text;
        if (item.type === "tool_use") {
          const args = JSON.stringify(item.input || {});
          // All models get the same XML-tagged JSON format — it's self-describing
          // and unambiguous, no need for model-specific variants.
          return `${TC_OPEN}${JSON.stringify({ name: item.name, arguments: JSON.parse(args) })}${TC_CLOSE}`;
        }
        if (item.type === "tool_result") {
          let result = typeof item.content === "string"
            ? item.content
            : Array.isArray(item.content)
              ? item.content.map(c => c.text || "").join("")
              : JSON.stringify(item.content || {});
          // Strip tool-call tags from tool_result text — subagents that also
          // route through windsurf may emit raw tool-call patterns in their
          // output. If we pass these through verbatim, the parent model sees
          // them and mimics the format → emits raw text → end_turn → session
          // stop (session 89893ae0).
          result = result.replace(new RegExp(TC_OPEN, "gi"), "[TOOL_RESULT]");
          return `<tool_result tool_call_id="${item.tool_use_id}">\n${result}\n</tool_result>`;
        }
        return "";
      });
      // Join with newline when tool blocks are present (so tool calls/results
      // sit on their own lines); plain multimodal text joins without separator
      // to preserve original behavior.
      const hasToolBlock = content.some(item =>
        item.type === "tool_use" || item.type === "tool_result");
      return hasToolBlock ? parts.join("\n") : parts.join("");
    }
    return String(content || "");
  }
}
