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

    // F9: Convert OpenAI messages[] to protobuf messages (extract text from multimodal)
    // D3: Include tool messages
    // GLM-5.2 (free-tier) doesn't support native function calling — Windsurf Cascade
    // may inject its own tools (agent__explore__medium, etc.) and ignore passed toolDefs.
    // Inject a system-prompt instruction forcing the model to use the CLIENT's tools
    // (Read/Write/Bash/...) via the [TOOL_CALLS]name[TOOL_CALLS]{json} inline format
    // so the openai-to-claude response translator can parse them into tool_use blocks.
    const toolDefs = body.tools && body.tools.length > 0
      ? body.tools.map(t => {
          const fn = t.function || t;
          return { name: fn.name, description: fn.description || "", schema: fn.parameters || {} };
        })
      : null;

    let messagesForProto = body.messages;
    if (toolDefs && toolDefs.length > 0) {
      const toolList = toolDefs.map(t =>
        `- ${t.name}: ${t.description}\n  args schema: ${JSON.stringify(t.schema)}`
      ).join("\n");
      const toolInstruction =
        `You have access to these tools. Use them when needed:\n${toolList}\n\n` +
        `To call a tool, output EXACTLY this format (no markdown, no backticks):\n` +
        `[TOOL_CALLS]<tool_name>[TOOL_CALLS]{<json_arguments>}\n\n` +
        `Example: [TOOL_CALLS]Read[TOOL_CALLS]{"file_path":"/tmp/foo.txt"}\n\n` +
        `Rules:\n` +
        `- ONLY use tool names from the list above. Do NOT invent tool names like agent__explore__medium.\n` +
        `- NEVER use your own model name (e.g. "glm-5-2") as a tool name. The tool name MUST be one of: ${toolDefs.map(t => t.name).join(", ")}.\n` +
        `- Arguments MUST be valid JSON matching the tool's schema.\n` +
        `- Output the tool call on its own line. You may add brief text before it.\n` +
        `- After a tool result is returned, continue the task or call another tool.\n`;
      // Prepend to existing system message if present, else insert new one
      const firstSysIdx = messagesForProto.findIndex(m => m.role === "system");
      if (firstSysIdx >= 0) {
        messagesForProto = messagesForProto.map((m, i) =>
          i === firstSysIdx
            ? { ...m, content: toolInstruction + "\n\n" + this._extractTextContent(m.content) }
            : m
        );
      } else {
        messagesForProto = [{ role: "system", content: toolInstruction }, ...messagesForProto];
      }
    }

    const protoMessages = messagesForProto.map((m) => ({
      role: m.role === "user" ? 1 : m.role === "assistant" ? 2 : m.role === "tool" ? 5 : 5,
      content: this._extractTextContent(m.content),
      opts: {},
    }));

    // Build protobuf request — resolve user-facing model ID to Cascade upstream ID
    const upstreamModel = getModelUpstreamId("windsurf", model);
    const protoBytes = _buildRequest(apiKey, jwt, protoMessages, toolDefs, upstreamModel);

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
            resp = await _streamingRequest(protoBytes, 30000, 2, signal);
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
        const resp = await _streamingRequest(protoBytes, 30000, 2, signal);
        const arrayBuf = await resp.arrayBuffer();
        const frames = connectFrameDecode(Buffer.from(arrayBuf));
        let fullText = "";
        for (const frame of frames) {
          const strings = extractStrings(frame);
          fullText += strings.join("");
        }
        fullText = this._stripStopTokens(fullText);

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
   */
  _extractTextContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(item => item.type === "text")
        .map(item => item.text)
        .join("");
    }
    return String(content || "");
  }
}
