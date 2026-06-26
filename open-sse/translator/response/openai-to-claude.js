import { register } from "../index.js";
import { FORMATS } from "../formats.js";

// Prefix for Claude OAuth tool names (must match request translator)
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// Sanitize tool call arguments to fix bad params from non-Anthropic models
function sanitizeToolArgs(toolName, argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const name = toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
      ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
      : toolName;
    if (name === "Read") sanitizeReadArgs(args);
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
}

function sanitizeReadArgs(args) {
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) args.offset = Number(args.offset);

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

function isValidPdfPagesArg(filePath, pages) {
  return typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages);
}

// Helper: stop thinking block if started
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex
  });
  state.thinkingBlockStarted = false;
}

// Helper: stop text block if started
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex
  });
  state.textBlockStarted = false;
}

// Helper: emit a text segment (starts text block if needed)
function emitTextSegment(state, results, text) {
  if (!text) return;
  if (!state.textBlockStarted) {
    state.textBlockIndex = state.nextBlockIndex++;
    state.textBlockStarted = true;
    state.textBlockClosed = false;
    results.push({
      type: "content_block_start",
      index: state.textBlockIndex,
      content_block: { type: "text", text: "" }
    });
  }
  results.push({
    type: "content_block_delta",
    index: state.textBlockIndex,
    delta: { type: "text_delta", text }
  });
}

// Helper: emit a tool_use block from GLM inline tool call.
// Returns true if a tool_use block was emitted, false if the input was
// degenerate (empty/invalid tool name) and was emitted as text instead.
function emitGlmToolUse(state, results, toolName, argsJson, originalText) {
  // Strip Claude OAuth prefix if present
  let bareName = (toolName || "").trim();
  if (bareName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
    bareName = bareName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
  }

  // GLM-5.2 sometimes hallucinates the model name (e.g. "glm-5-2") as the tool
  // name. Infer the real tool from the args shape so Claude Code doesn't reject
  // with "No such tool available".
  bareName = inferToolFromNameAndArgs(bareName, argsJson);

  // Guard: if the tool name is still empty/whitespace after inference, do NOT
  // emit a tool_use block with name="" (Claude Code rejects it). Emit the raw
  // text instead so nothing is silently dropped and the turn doesn't break.
  if (!bareName || !bareName.trim()) {
    emitTextSegment(state, results, originalText != null ? originalText : `[TOOL_CALLS]${toolName}[TOOL_CALLS]${argsJson}`);
    return false;
  }

  stopThinkingBlock(state, results);
  stopTextBlock(state, results);

  const toolBlockIndex = state.nextBlockIndex++;
  const toolId = `toolu_glm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  results.push({
    type: "content_block_start",
    index: toolBlockIndex,
    content_block: {
      type: "tool_use",
      id: toolId,
      name: bareName,
      input: {}
    }
  });

  // Sanitize + emit args
  const sanitized = sanitizeToolArgs(bareName, argsJson);
  results.push({
    type: "content_block_delta",
    index: toolBlockIndex,
    delta: { type: "input_json_delta", partial_json: sanitized }
  });

  results.push({
    type: "content_block_stop",
    index: toolBlockIndex
  });

  // Track for finish handler (so it doesn't try to re-stop)
  const idx = state.toolCalls.size;
  state.toolCalls.set(idx, { id: toolId, name: bareName, blockIndex: toolBlockIndex, glmEmitted: true });
}

// Detect suspicious tool names that look like model names (e.g. "glm-5-2",
// "gpt-4", "claude-3-5-sonnet"). These are hallucinations — the model emitted
// its own name instead of the real tool name.
function looksLikeModelName(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  // Known model family prefixes
  if (/^(glm|gpt|claude|sonnet|opus|haiku|gemini|llama|mistral|qwen|deepseek|kimi|grok|o[0-9])[-_]/.test(lower)) return true;
  // Contains version-like pattern: digit-dot or digit-dash-digit (e.g. "5-2", "4.1")
  if (/\d[-_.]\d/.test(name)) return true;
  return false;
}

// Infer the real Claude Code tool name from the args shape when the model
// hallucinated an invalid tool name (e.g. used the model name).
function inferToolFromNameAndArgs(name, argsJson) {
  // Only remap if the name looks suspicious (model name or unknown).
  // Common Claude Code tools we know about — if name is already valid, keep it.
  const knownTools = new Set([
    "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch",
    "Agent", "Task", "TodoWrite", "NotebookEdit", "MultiEdit", "BashOutput",
    "KillShell", "WaitForMcpServers", "SlashCommand", "ListMcpTools",
  ]);
  if (knownTools.has(name)) return name;
  // MCP tools have double-underscore or colon patterns — keep those too
  if (name && (name.includes("__") || name.includes(":"))) return name;

  // If name looks like a model name (or is otherwise unknown), infer from args
  let args = {};
  try { args = JSON.parse(argsJson); } catch { return name; }

  const keys = Object.keys(args);
  const has = (k) => keys.includes(k);

  // IMPORTANT: order from most-specific shape to least-specific. A broad check
  // (e.g. Read on `file_path`, or Grep on `pattern`) must not shadow a more
  // specific tool (Edit, Glob) that shares the same key.

  // Edit: file_path + old_string + new_string (most specific file op)
  if (has("file_path") && has("old_string") && has("new_string")) return "Edit";
  // Write: file_path + content
  if (has("file_path") && has("content")) return "Write";
  // Glob: path + pattern, no file_path (more specific than Grep)
  if (has("path") && has("pattern") && !has("file_path")) return "Glob";
  // Read: file_path only (no content/command/pattern)
  if (has("file_path") && !has("content") && !has("command") && !has("pattern")) return "Read";
  // Bash: command (+ optional description/timeout)
  if (has("command")) return "Bash";
  // Grep: pattern (+ optional path/glob)
  if (has("pattern")) return "Grep";
  // Agent/Task: prompt + subagent_type
  if (has("prompt") && has("subagent_type")) return "Agent";
  // WebFetch: url
  if (has("url")) return "WebFetch";
  // WebSearch: query
  if (has("query")) return "WebSearch";
  // TodoWrite: todos
  if (has("todos")) return "TodoWrite";

  // Last resort: if name looks like a model name but we can't infer, default
  // to Bash if there's a command-like field, else Read. Better than rejecting.
  if (looksLikeModelName(name)) {
    if (has("file_path")) return "Read";
    if (has("command")) return "Bash";
  }
  return name;
}

// Parse + drain GLM-5.2 inline tool calls from buffer.
// Format: [TOOL_CALLS]name[TOOL_CALLS]{json} or [TOOL_CALLS]name[ARGS]{json}
// Returns true if something was emitted (caller should loop), false if buffer
// is empty or holds an incomplete token that needs more chunks.
function drainGlmInlineToolCalls(state, results) {
  if (!state.glmTextBuffer) return false;

  const buf = state.glmTextBuffer;
  const marker = "[TOOL_CALLS]";
  const markerIdx = buf.indexOf(marker);

  // No marker at all — but buffer might end with a partial marker prefix.
  // Keep up to 12 chars (len("[TOOL_CALLS]")) at the end to avoid splitting.
  if (markerIdx === -1) {
    if (buf.length <= marker.length) return false; // wait for more
    // Check if buffer ends with a partial "[TOOL_CALLS]" prefix.
    // Only retain prefixes >= 3 chars ("[TO") — shorter prefixes like "["
    // or "[T" are too common in normal text and would cause false buffering.
    for (let i = marker.length - 1; i >= 3; i--) {
      if (buf.endsWith(marker.slice(0, i))) {
        // Emit safe text before partial marker, keep partial
        const safeEnd = buf.length - i;
        if (safeEnd > 0) {
          emitTextSegment(state, results, buf.slice(0, safeEnd));
          state.glmTextBuffer = buf.slice(safeEnd);
        }
        return false;
      }
    }
    // No partial marker — emit everything
    emitTextSegment(state, results, buf);
    state.glmTextBuffer = "";
    return false;
  }

  // Emit text before marker
  if (markerIdx > 0) {
    emitTextSegment(state, results, buf.slice(0, markerIdx));
  }

  const afterMarker = buf.slice(markerIdx + marker.length);
  // Find second marker: [TOOL_CALLS] or [ARGS]
  const secondMarkerRe = /\[(TOOL_CALLS|ARGS)\]/;
  const m2 = afterMarker.match(secondMarkerRe);

  // Determine toolName + afterSecondMarker via two formats:
  //  (a) [TOOL_CALLS]name[TOOL_CALLS]{json}  or  [TOOL_CALLS]name[ARGS]{json}
  //  (b) [TOOL_CALLS]name: {json}  (colon separator, no second marker)
  let toolName, afterSecondMarker;
  if (m2) {
    toolName = afterMarker.slice(0, m2.index);
    afterSecondMarker = afterMarker.slice(m2.index + m2[0].length);
  } else {
    const colonJsonMatch = afterMarker.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\{)/);
    if (colonJsonMatch) {
      toolName = colonJsonMatch[1];
      afterSecondMarker = afterMarker.slice(afterMarker.indexOf("{"));
    } else {
      // Incomplete — keep marker + afterMarker so flush-at-finish preserves the
      // original text (no silent drop of the "[TOOL_CALLS]" we already consumed).
      state.glmTextBuffer = marker + afterMarker;
      return false;
    }
  }

  // Find JSON object: starts with { , ends with matching }
  const jsonStart = afterSecondMarker.indexOf("{");
  if (jsonStart === -1) {
    if (afterSecondMarker === "" || /^\s*$/.test(afterSecondMarker)) {
      // JSON not started yet — wait for more chunks
      state.glmTextBuffer = marker + afterMarker;
      return false;
    }
    // Malformed (no JSON) — emit as text and move on
    emitTextSegment(state, results, marker + toolName + m2[0] + afterSecondMarker);
    state.glmTextBuffer = "";
    return true;
  }

  // Find matching closing brace (handle nested + strings)
  let depth = 0, jsonEnd = -1, inStr = false, esc = false;
  for (let i = jsonStart; i < afterSecondMarker.length; i++) {
    const ch = afterSecondMarker[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { jsonEnd = i; break; }
    }
  }

  if (jsonEnd === -1) {
    // Incomplete JSON — wait for more chunks. Keep marker + afterMarker so
    // flush-at-finish preserves original text.
    state.glmTextBuffer = marker + afterMarker;
    return false;
  }

  const argsJson = afterSecondMarker.slice(jsonStart, jsonEnd + 1);
  const remainder = afterSecondMarker.slice(jsonEnd + 1);
  // Original consumed text (for fallback if tool name is degenerate)
  const consumedText = buf.slice(markerIdx, buf.length - afterSecondMarker.length + jsonEnd + 1);

  // Emit tool_use block (or text fallback if tool name is empty/invalid)
  emitGlmToolUse(state, results, toolName, argsJson, consumedText);

  // Continue with remainder
  state.glmTextBuffer = remainder;
  return true; // loop to drain more
}

// Convert OpenAI stream chunk to Claude format
export function openaiToClaudeResponse(chunk, state) {
  if (!chunk || !chunk.choices?.[0]) return null;

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // Track usage from OpenAI chunk if available
  if (chunk.usage && typeof chunk.usage === "object") {
    const promptTokens = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0;
    const outputTokens = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0;

    // Extract cache tokens from prompt_tokens_details
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
    const cacheCreationTokens = chunk.usage.prompt_tokens_details?.cache_creation_tokens;
    const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
    const cacheCreateTokens = typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;

    // input_tokens = prompt_tokens - cached_tokens - cache_creation_tokens
    // Because OpenAI's prompt_tokens includes all prompt-side tokens
    const inputTokens = promptTokens - cacheReadTokens - cacheCreateTokens;

    state.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    };

    // Add cache_read_input_tokens if present
    if (cacheReadTokens > 0) {
      state.usage.cache_read_input_tokens = cacheReadTokens;
    }

    // Add cache_creation_input_tokens if present
    if (cacheCreateTokens > 0) {
      state.usage.cache_creation_input_tokens = cacheCreateTokens;
    }

    // Note: completion_tokens_details.reasoning_tokens is already included in output_tokens
    // No need to add separately as Claude expects total output_tokens
  }

  // First chunk - ALWAYS send message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
    if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
      state.messageId = chunk.extend_fields?.requestId ||
        chunk.extend_fields?.traceId ||
        `msg_${Date.now()}`;
    }
    state.model = chunk.model || "unknown";
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  // Handle reasoning_content (thinking) - GLM, DeepSeek, etc.
  const reasoningContent = delta?.reasoning_content || delta?.reasoning;
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: "thinking", thinking: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent }
    });
  }

  // Handle regular content
  // GLM-5.2 (and similar non-Anthropic models) may embed tool calls inline as
  // text markers: [TOOL_CALLS]name[TOOL_CALLS]{json} or [TOOL_CALLS]name[ARGS]{json}
  // Parse these and convert to proper tool_use blocks so Claude Code can execute them.
  if (delta?.content) {
    stopThinkingBlock(state, results);

    // Initialize GLM inline-tool-call buffer if not present
    if (!state.glmTextBuffer) state.glmTextBuffer = "";
    state.glmTextBuffer += delta.content;

    // Drain buffer: emit text segments and tool_use blocks for complete tokens
    let drained = drainGlmInlineToolCalls(state, results);
    while (drained) {
      drained = drainGlmInlineToolCalls(state, results);
    }
  }

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;

      if (tc.id) {
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);

        const toolBlockIndex = state.nextBlockIndex++;
        state.toolCalls.set(idx, { id: tc.id, name: tc.function?.name || "", blockIndex: toolBlockIndex });

        // Strip prefix from tool name for response
        let toolName = tc.function?.name || "";
        if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
          toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
        }

        results.push({
          type: "content_block_start",
          index: toolBlockIndex,
          content_block: {
            type: "tool_use",
            id: tc.id,
            name: toolName,
            input: {}
          }
        });
      }

      if (tc.function?.arguments) {
        const toolInfo = state.toolCalls.get(idx);
        if (toolInfo) {
          // Only Read needs arg clamping → buffer it (args are tiny, no gap risk)
          // and sanitize at finish. Every other tool (Write/Edit/...) streams
          // incrementally so large tool_use payloads never create a silent gap
          // that idles out the client mid-write.
          const bareName = toolInfo.name?.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
            ? toolInfo.name.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
            : toolInfo.name;
          if (bareName === "Read") {
            if (!state.toolArgBuffers) state.toolArgBuffers = new Map();
            const accumulated = (state.toolArgBuffers.get(idx) || "") + tc.function.arguments;
            state.toolArgBuffers.set(idx, accumulated);
            try {
              JSON.parse(accumulated);
              // Complete JSON → sanitize, emit, clear buffer so the finish
              // block doesn't double-emit.
              const sanitized = sanitizeToolArgs(toolInfo.name, accumulated);
              state.toolArgBuffers.delete(idx);
              results.push({
                type: "content_block_delta",
                index: toolInfo.blockIndex,
                delta: { type: "input_json_delta", partial_json: sanitized }
              });
            } catch {
              // Still partial — keep buffering, finish block will flush it.
            }
          } else {
            results.push({
              type: "content_block_delta",
              index: toolInfo.blockIndex,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments }
            });
          }
        }
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    // Flush any remaining GLM inline-tool-call buffer as text
    if (state.glmTextBuffer) {
      // Try to drain once more (in case last chunk had complete token)
      let drained = drainGlmInlineToolCalls(state, results);
      while (drained) drained = drainGlmInlineToolCalls(state, results);
      // Anything left is plain text (incomplete/no marker) — emit as text
      if (state.glmTextBuffer) {
        emitTextSegment(state, results, state.glmTextBuffer);
        state.glmTextBuffer = "";
      }
    }

    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    for (const [idx, toolInfo] of state.toolCalls) {
      // GLM-emitted tool_use blocks already stopped in emitGlmToolUse — skip
      if (toolInfo.glmEmitted) continue;
      // Emit buffered + sanitized args as single delta before stop
      const buffered = state.toolArgBuffers?.get(idx);
      if (buffered) {
        const sanitized = sanitizeToolArgs(toolInfo.name, buffered);
        results.push({
          type: "content_block_delta",
          index: toolInfo.blockIndex,
          delta: { type: "input_json_delta", partial_json: sanitized }
        });
      }
      results.push({
        type: "content_block_stop",
        index: toolInfo.blockIndex
      });
    }

    // Mark finish for later usage injection in stream.js
    state.finishReason = choice.finish_reason;

    // Use tracked usage (will be estimated in stream.js if not valid)
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
    // When GLM-5.2 emits inline [TOOL_CALLS] markers, Windsurf returns
    // finish_reason="stop" (model ended normally). But Claude Code needs
    // stop_reason="tool_use" to know it should execute the tool and continue
    // the turn. Override if any GLM-emitted tool_use block was emitted.
    const hasGlmToolUse = [...state.toolCalls.values()].some(t => t.glmEmitted);
    const stopReason = hasGlmToolUse
      ? "tool_use"
      : convertFinishReason(choice.finish_reason);
    results.push({
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: finalUsage
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

// Convert OpenAI finish_reason to Claude stop_reason
function convertFinishReason(reason) {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return "end_turn";
  }
}

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, null, openaiToClaudeResponse);
