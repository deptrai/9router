/**
 * DevinExecutor — OpenAI-compatible executor for Devin agent sessions (REST v3).
 *
 * Protocol: REST v3 POST /v3/organizations/{orgId}/sessions → poll GET /sessions/{id}
 * Auth: Service User API Key (cog_*) + Organization ID
 * Output: Re-wrap session output as OpenAI SSE (1 chunk + finish_reason=stop)
 *
 * WARNING: format 'devin' = executor owns format. Do NOT add response translator (F2).
 * If translator is added, passthrough will break.
 */

import { randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

export class DevinExecutor extends BaseExecutor {
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
    const authHeaders = {
      "Authorization": `Bearer ${credentials.apiKey}`,
      "Content-Type": "application/json",
    };

    // Extract orgId
    const orgId = credentials?.providerSpecificData?.orgId || process.env.DEVIN_ORG_ID;
    if (!orgId) {
      return this._errorResponse(400, "Devin requires Organization ID (providerSpecificData.orgId or DEVIN_ORG_ID env)");
    }

    // Map model → devin_mode (F4: keys match model id without provider prefix)
    const modeMap = {
      normal: "normal",
      fast: "fast",
      lite: "lite",
      ultra: "ultra",
    };
    const devinMode = modeMap[model] || "normal";

    // Convert messages[] → prompt text (QĐ15 format) + tools (D3)
    const prompt = this._messagesToPrompt(body.messages, body.tools);

    // POST /v3/organizations/{orgId}/sessions
    const createUrl = `https://api.devin.ai/v3/organizations/${encodeURIComponent(orgId)}/sessions`;
    const createBodyJson = { prompt, devin_mode: devinMode }; // F1: explicit key, no shorthand
    const createBody = JSON.stringify(createBodyJson);

    let sessionResp;
    try {
      sessionResp = await proxyAwareFetch(createUrl, { // F8: proxyAwareFetch
        method: "POST",
        headers: authHeaders,
        body: createBody,
        signal,
      }, proxyOptions);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      return this._errorResponse(502, `Devin session creation failed: ${e.message}`);
    }

    if (!sessionResp.ok) {
      // Parse error body để trả message cụ thể từ Devin API (vd: "devin_mode 'lite' is not available for this organization")
      let serverDetail = "";
      try {
        const errBody = await sessionResp.json();
        serverDetail = errBody?.detail || errBody?.message || errBody?.error || "";
      } catch {
        // Body không phải JSON — ignore
      }

      if (sessionResp.status === 403) {
        // 403 thường là out_of_quota — giữ message quen thuộc + thêm detail nếu có
        const msg = serverDetail ? `Devin out_of_quota — ${serverDetail}` : "Devin out_of_quota — billing required";
        return this._errorResponse(403, msg);
      }
      if (sessionResp.status === 404) {
        return this._errorResponse(404, serverDetail || "Devin Organization ID not found");
      }
      if (sessionResp.status === 401) {
        return this._errorResponse(401, serverDetail || "Devin API key invalid");
      }
      if (sessionResp.status === 400) {
        // 400 = bad request — trả detail cụ thể (vd: mode không available, prompt thiếu)
        return this._errorResponse(400, serverDetail ? `Devin bad request: ${serverDetail}` : "Devin bad request");
      }
      // Fallback: include server detail nếu có
      const fallbackMsg = serverDetail
        ? `Devin session creation failed: HTTP ${sessionResp.status} — ${serverDetail}`
        : `Devin session creation failed: HTTP ${sessionResp.status}`;
      return this._errorResponse(502, fallbackMsg);
    }

    const sessionData = await sessionResp.json();
    const sessionId = sessionData.id;
    if (!sessionId) {
      return this._errorResponse(502, "Devin session creation failed: no session_id in response");
    }

    // Poll loop
    const pollIntervalMs = Number(process.env.DEVIN_POLL_INTERVAL_MS) || 2000;
    const timeoutMs = Number(process.env.DEVIN_SESSION_TIMEOUT_MS) || 30 * 60 * 1000;
    const startTime = Date.now();
    const pollUrl = `https://api.devin.ai/v3/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}`;
    const maxPollRetries = 3;

    let session;
    try {
      while (true) {
        if (signal?.aborted) {
          await this._cancelSession(pollUrl, authHeaders, proxyOptions); // F12: cancel on abort
          throw new Error("Devin session poll aborted");
        }

        if (Date.now() - startTime > timeoutMs) {
          await this._cancelSession(pollUrl, authHeaders, proxyOptions);
          return this._errorResponse(504, `Devin session timed out after ${timeoutMs / 1000}s`);
        }

        // F11: Abort-safe sleep with clearTimeout
        await this._abortableSleep(pollIntervalMs, signal);

        // F13: Retry on transient 5xx
        let pollResp;
        let pollRetries = 0;
        while (true) {
          try {
            pollResp = await proxyAwareFetch(pollUrl, {
              headers: authHeaders,
              signal,
            }, proxyOptions);
          } catch (e) {
            if (e.name === "AbortError") throw e;
            if (pollRetries < maxPollRetries) {
              pollRetries++;
              await this._abortableSleep(1000 * pollRetries, signal);
              continue;
            }
            throw e;
          }
          if (!pollResp.ok && pollResp.status >= 500 && pollRetries < maxPollRetries) {
            pollRetries++;
            await this._abortableSleep(1000 * pollRetries, signal);
            continue;
          }
          break;
        }

        if (!pollResp.ok) {
          return this._errorResponse(502, `Devin session poll failed: HTTP ${pollResp.status}`);
        }

        session = await pollResp.json();
        const statusEnum = session.status_enum;

        if (statusEnum === "finished") {
          break;
        }

        if (statusEnum === "blocked") {
          return this._errorResponse(503, "Devin session blocked — waiting for human input");
        }

        if (statusEnum === "expired") {
          return this._errorResponse(503, "Devin session expired");
        }

        if (statusEnum === "error") {
          return this._errorResponse(502, "Devin session error");
        }

        // F14: Unknown status_enum → throw (don't spin until timeout)
        if (statusEnum && !["running", "planning", "executing"].includes(statusEnum)) {
          return this._errorResponse(502, `Devin session unknown status: ${statusEnum}`);
        }
      }
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (e.message?.includes("aborted")) throw e;
      return this._errorResponse(502, e.message);
    }

    // Extract output
    const output = session.output || "";
    const completionId = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24); // F28: unique ID

    // Re-wrap as OpenAI format (F1)
    if (stream) {
      const streamController = new ReadableStream({
        start(controller) {
          const chunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { content: output },
              finish_reason: null,
            }],
          };
          controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);

          const finalChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop",
            }],
          };
          controller.enqueue(`data: ${JSON.stringify(finalChunk)}\n\n`);
          controller.enqueue("data: [DONE]\n\n");
          controller.close();
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

      return { response, url: createUrl, headers: authHeaders, transformedBody: createBodyJson }; // F31: actual upstream body
    } else {
      const jsonBody = {
        id: completionId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: output,
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

      return { response, url: createUrl, headers: authHeaders, transformedBody: createBodyJson }; // F31: actual upstream body
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
   * Abortable sleep — clearTimeout on abort (F11).
   */
  _abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const timer = setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  /**
   * Cancel Devin session on abort (F12).
   */
  async _cancelSession(pollUrl, authHeaders, proxyOptions) {
    try {
      await proxyAwareFetch(pollUrl, {
        method: "DELETE",
        headers: authHeaders,
        signal: AbortSignal.timeout(5000),
      }, proxyOptions);
    } catch {
      // Best-effort cancel — don't block on failure
    }
  }

  /**
   * Convert OpenAI messages[] + tools to Devin prompt text (QĐ15 format + D3 tool support).
   * Format: [System: ...]\n\nUser: ...\n\nAssistant: ...
   * Tools appended as: [Available tools: ...]
   */
  _messagesToPrompt(messages, tools) {
    if (!messages || messages.length === 0) return "";

    let prompt = "";

    // D3: Append tool definitions
    if (tools && tools.length > 0) {
      const toolList = tools.map(t => {
        const fn = t.function || t;
        return `- ${fn.name}: ${fn.description || ""}`;
      }).join("\n");
      prompt += `[Available tools:\n${toolList}\n]\n\n`;
    }

    for (const m of messages) {
      const role = m.role || "user";
      const content = this._extractTextContent(m.content);

      if (role === "system") {
        prompt += `[System: ${content}]\n\n`;
      } else if (role === "user") {
        prompt += `User: ${content}\n\n`;
      } else if (role === "assistant") {
        // D3: Include tool_calls if present
        let assistantText = content;
        if (m.tool_calls && m.tool_calls.length > 0) {
          const calls = m.tool_calls.map(tc => {
            const fn = tc.function || {};
            return `[tool_call: ${fn.name}(${fn.arguments || "{}"})]`;
          }).join(" ");
          assistantText = (assistantText + " " + calls).trim();
        }
        prompt += `Assistant: ${assistantText}\n\n`;
      } else if (role === "tool") {
        // D3: Include tool results
        prompt += `[Tool result: ${content}]\n\n`;
      }
    }

    return prompt;
  }

  /**
   * Extract text from content (string or array with multimodal).
   * Devin prompt is text-only — ignore image/tool parts.
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
