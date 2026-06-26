import { register } from "../index.js";
import { FORMATS } from "../formats.js";

// Prefix for Claude OAuth tool names (must match request translator)
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// F25: Find end index of a JSON object starting with '{'. Returns -1 if incomplete.
function findJsonEnd(str) {
  if (!str.startsWith("{")) return -1;
  let depth = 0, inStr = false, escape = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1; // incomplete
}

// F27: Detect raw shell commands in text (no [TOOL_CALLS] marker).
// Sonnet via Cascade sometimes emits raw commands directly in text:
//   "Let me search.rg "mcp" /path --exclude-dir tests"
//   "I'll read that file.cat /path/to/file"
//   "Running: ls -la /tmp"
// Scan for known command patterns and synthesize tool calls.
// Returns {beforeText, toolName, argsJson, afterText} or null.
function detectRawCommandInText(text) {
  // rg/grep "pattern" /path [--flags...]
  // Require: quoted pattern + path starting with / . ~ OR --flag
  const grepRe = /(?:^|[\s.])(rg|grep)\s+["']([^"']+)["']\s+(\/[^\s]+|\.\.?[^\s]*|~[^\s]+|--[^\s]+)/;
  const grepMatch = text.match(grepRe);
  if (grepMatch) {
    const matchStart = grepMatch.index + (grepMatch[0].startsWith(grepMatch[1]) ? 0 : 1);
    const matchEnd = matchStart + grepMatch[0].length - (grepMatch[0].startsWith(grepMatch[1]) ? 0 : 1);
    // Extract full command line until end of text or newline
    const lineEnd = text.indexOf("\n", matchEnd);
    const cmdEnd = lineEnd === -1 ? text.length : lineEnd;
    const fullCmd = text.slice(matchStart, cmdEnd).trim();
    const beforeText = text.slice(0, matchStart).trim();
    const afterText = text.slice(cmdEnd);
    // Parse path from the full command
    const pathMatch = fullCmd.match(/\s(\/[^\s]+|\.\.?[^\s]*|~[^\s]+)/);
    const path = pathMatch ? pathMatch[1] : ".";
    const pattern = grepMatch[2];
    return {
      beforeText,
      toolName: "Grep",
      argsJson: JSON.stringify({ pattern, path }),
      afterText,
    };
  }

  // cat /path/to/file → Read
  const catRe = /(?:^|[\s.])(cat)\s+(\/[^\s]+|\.\.?[^\s]*|~[^\s]+)/;
  const catMatch = text.match(catRe);
  if (catMatch) {
    const matchStart = catMatch.index + (catMatch[0].startsWith(catMatch[1]) ? 0 : 1);
    const matchEnd = matchStart + catMatch[0].length - (catMatch[0].startsWith(catMatch[1]) ? 0 : 1);
    const beforeText = text.slice(0, matchStart).trim();
    const afterText = text.slice(matchEnd);
    return {
      beforeText,
      toolName: "Read",
      argsJson: JSON.stringify({ file_path: catMatch[2] }),
      afterText,
    };
  }

  // ls -la /path → Bash (only if has path)
  const lsRe = /(?:^|[\s.])((?:ls|pwd|find)\s+[^\n]+)/;
  const lsMatch = text.match(lsRe);
  if (lsMatch && lsMatch[1]) {
    const cmd = lsMatch[1].trim();
    // Only trigger if command has a path argument
    if (/\/[^\s]/.test(cmd) || /\.\.?[^\s]/.test(cmd)) {
      const matchStart = lsMatch.index + (lsMatch[0].startsWith(lsMatch[1]) ? 0 : 1);
      const matchEnd = matchStart + lsMatch[1].length;
      const beforeText = text.slice(0, matchStart).trim();
      const afterText = text.slice(matchEnd);
      return {
        beforeText,
        toolName: "Bash",
        argsJson: JSON.stringify({ command: cmd }),
        afterText,
      };
    }
  }

  return null;
}

// F25/F26: Infer tool name from JSON args keys when model omits tool name.
// Sonnet via Cascade emits [TOOL_CALLS]{"command":"ls"} or
// [TOOL_CALLS]\n[TOOL_CALLS]{"file_path":"/path"} — no tool name.
// F26: Also handles {"tool":"serena","action":"find_symbol","name":"mcp"} pattern
// where model wraps the real tool call inside a generic {tool,action} envelope.
// Returns {name, argsJson} with remapped args, or null if can't infer.
function inferToolNameFromArgs(argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const keys = Object.keys(args);
    const has = (k) => keys.includes(k);

    // F26: {tool, action} envelope pattern — remap to real MCP tool + args
    if (has("tool") && has("action") && typeof args.tool === "string") {
      const tool = args.tool.toLowerCase().trim();
      const action = typeof args.action === "string" ? args.action.toLowerCase().trim() : "";
      // Serena: {tool:"serena", action:"find_symbol", name:"foo"} → mcp__serena__find_symbol, {symbol:"foo"}
      if (tool === "serena") {
        const serenaMap = {
          find_symbol: "mcp__serena__find_symbol",
          find_referencing_symbols: "mcp__serena__find_referencing_symbols",
          find_symbol_matches: "mcp__serena__find_symbol_matches",
          get_symbols_overview: "mcp__serena__get_symbols_overview",
          replace_symbol_body: "mcp__serena__replace_symbol_body",
          insert_after_symbol: "mcp__serena__insert_after_symbol",
          insert_before_symbol: "mcp__serena__insert_before_symbol",
          rename_symbol: "mcp__serena__rename_symbol",
          activate_project: "mcp__serena__activate_project",
        };
        const mcpName = serenaMap[action];
        if (mcpName) {
          // Remap args: strip tool/action wrapper, keep meaningful fields
          const remapped = {};
          if (has("name")) remapped.symbol = args.name;
          if (has("symbol")) remapped.symbol = args.symbol;
          if (has("include_body")) remapped.include_body = args.include_body;
          if (has("workspace")) remapped.workspace = args.workspace;
          if (has("path")) remapped.path = args.path;
          if (has("new_name")) remapped.new_name = args.new_name;
          if (has("body")) remapped.body = args.body;
          if (has("relative_path")) remapped.relative_path = args.relative_path;
          return { name: mcpName, argsJson: JSON.stringify(remapped) };
        }
      }
      // context-engine: {tool:"context-engine", action:"codebase-retrieval", query:"..."}
      if (tool === "context-engine" || tool === "vibervn-context-engine") {
        const remapped = {};
        if (has("query")) remapped.query = args.query;
        if (has("workspace")) remapped.workspace_full_path = args.workspace;
        if (has("workspace_full_path")) remapped.workspace_full_path = args.workspace_full_path;
        if (has("mode")) remapped.mode = args.mode;
        return { name: "mcp__vibervn-context-engine__codebase-retrieval", argsJson: JSON.stringify(remapped) };
      }
      // code-review-graph
      if (tool === "code-review-graph" || tool === "crg") {
        const crgMap = {
          detect_changes: "mcp__code-review-graph__detect_changes_tool",
          get_impact_radius: "mcp__code-review-graph__get_impact_radius_tool",
          build_or_update_graph: "mcp__code-review-graph__build_or_update_graph_tool",
          get_suggested_questions: "mcp__code-review-graph__get_suggested_questions_tool",
        };
        const mcpName = crgMap[action];
        if (mcpName) {
          const remapped = { ...args };
          delete remapped.tool;
          delete remapped.action;
          return { name: mcpName, argsJson: JSON.stringify(remapped) };
        }
      }
    }

    // F29: {skill, args} envelope — model tries to invoke a skill
    // {"skill":"codebase-memory","args":{"query":"mcp","mode":"calls"}}
    // → Skill tool with {command:"invoke", skill:"codebase-memory", ...args}
    if (has("skill") && typeof args.skill === "string") {
      const remapped = { command: "invoke", skill: args.skill };
      if (has("args") && typeof args.args === "object" && args.args) {
        Object.assign(remapped, args.args);
      }
      // Also copy any direct keys (not wrapped in args)
      for (const k of keys) {
        if (k !== "skill" && k !== "args" && !(k in remapped)) {
          remapped[k] = args[k];
        }
      }
      return { name: "Skill", argsJson: JSON.stringify(remapped) };
    }

    // F30: {tool:"Bash"|"Read"|"Grep"|..., cmd|command|...} envelope
    // Model wraps real tool name in "tool" key + uses "cmd" instead of "command"
    // {"cmd":"grep -r 'mcp' /path","tool":"Bash"} → Bash {command:"grep..."}
    // {"cmd":"cat /file","tool":"Read"} → Read {file_path:"/file"} (remap cmd→cat target)
    if (has("tool") && typeof args.tool === "string" && !has("action")) {
      const wrappedTool = args.tool.toLowerCase().trim();
      const toolMap = {
        bash: "Bash", read: "Read", write: "Write", edit: "Edit",
        grep: "Grep", glob: "Glob", agent: "Agent", task: "Agent",
        webfetch: "WebFetch", websearch: "WebSearch",
      };
      const mappedName = toolMap[wrappedTool];
      if (mappedName) {
        const remapped = { ...args };
        delete remapped.tool;
        // cmd → command for Bash
        if (has("cmd") && !has("command")) {
          remapped.command = remapped.cmd;
          delete remapped.cmd;
        }
        // For Read: if has command (or cmd→command) like "cat /file", extract file_path
        if (mappedName === "Read" && typeof remapped.command === "string") {
          const catMatch = remapped.command.match(/cat\s+(\/[^\s]+|\.\.?[^\s]*|~[^\s]+)/);
          if (catMatch) {
            remapped.file_path = catMatch[1];
            delete remapped.command;
          }
        }
        // For Grep: if has command like "grep -r 'pattern' /path", extract
        if (mappedName === "Grep" && typeof remapped.command === "string") {
          const grepMatch = remapped.command.match(/grep\s+-\w*\s*["']?([^"'\s]+)["']?\s+(\/[^\s]+|\.\.?[^\s]*|~[^\s]+)/);
          if (grepMatch) {
            remapped.pattern = grepMatch[1];
            remapped.path = grepMatch[2];
            delete remapped.command;
          }
        }
        // Strip unknown keys for clean tool args
        return { name: mappedName, argsJson: JSON.stringify(remapped) };
      }
    }

    // F25: Direct key pattern inference (no envelope)
    // F30 alias: cmd → command (Bash) when no tool wrapper
    if (has("cmd") && typeof args.cmd === "string" && !has("command")) {
      return { name: "Bash", argsJson: JSON.stringify({ command: args.cmd }) };
    }
    // Bash: command (string), optional run_in_background/timeout
    if (has("command") && typeof args.command === "string") return { name: "Bash", argsJson };
    // Read: file_path (string)
    if (has("file_path") && typeof args.file_path === "string" && !has("old_string") && !has("content")) return { name: "Read", argsJson };
    // Edit: file_path + old_string + new_string
    if (has("file_path") && has("old_string") && has("new_string")) return { name: "Edit", argsJson };
    // Write: file_path + content
    if (has("file_path") && has("content") && !has("old_string")) return { name: "Write", argsJson };
    // Grep: pattern (string), optional path/glob_pattern
    if (has("pattern") && typeof args.pattern === "string" && has("path")) return { name: "Grep", argsJson };
    // Glob: pattern (string), no other key
    if (has("pattern") && typeof args.pattern === "string" && keys.length === 1) return { name: "Glob", argsJson };
    // Grep with just pattern (no path)
    if (has("pattern") && typeof args.pattern === "string" && !has("file_path")) return { name: "Grep", argsJson };
    // Agent/Task: prompt + description, or subagent_type + prompt
    if (has("prompt") && (has("description") || has("subagent_type"))) return { name: "Agent", argsJson };
    if (has("prompt") && has("agent_type")) return { name: "Agent", argsJson };
    // TodoWrite: todos (array)
    if (has("todos") && Array.isArray(args.todos)) return { name: "TodoWrite", argsJson };
    // WebFetch: url
    if (has("url") && typeof args.url === "string") return { name: "WebFetch", argsJson };
    // WebSearch: query
    if (has("query") && typeof args.query === "string" && !has("workspace_full_path")) return { name: "WebSearch", argsJson };
    // Serena find_symbol: find_symbol key
    if (has("find_symbol")) return { name: "mcp__serena__find_symbol", argsJson };
    if (has("find_referencing_symbols")) return { name: "mcp__serena__find_referencing_symbols", argsJson };
    if (has("get_symbols_overview")) return { name: "mcp__serena__get_symbols_overview", argsJson };
    // context-engine: workspace_full_path + query
    if (has("workspace_full_path") && has("query")) return { name: "mcp__vibervn-context-engine__codebase-retrieval", argsJson };
    return null; // can't infer
  } catch {
    return null;
  }
}

// Sanitize tool call arguments to fix bad params from non-Anthropic models
function sanitizeToolArgs(toolName, argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const name = toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
      ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
      : toolName;
    if (name === "Read") sanitizeReadArgs(args);
    if (name === "Bash") sanitizeBashArgs(args);
    if (name === "Agent" || name === "Task") sanitizeAgentArgs(args);
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
}

// Claude Code Bash tool only accepts these fields. Non-Anthropic models
// (notably GLM-5.2) hallucinate extra fields like `working_directory` which
// Claude Code rejects with InputValidationError → model retries same bad
// args → loop → session stuck. Strip unknown fields so the tool call lands.
// Also auto-quote unquoted glob patterns in --include/--exclude to prevent
// zsh "no matches found" errors (GLM-5.2 writes bash-style unquoted globs).
function sanitizeBashArgs(args) {
  const allowed = new Set([
    "command", "run_in_background", "shell_id", "timeout",
    "interactive_shell", "idle_timeout", "output_processing",
  ]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) delete args[key];
  }
  if (typeof args.command === "string") {
    args.command = quoteGlobPatterns(args.command);
  }
}

// Quote unquoted glob patterns in grep/find --include/--exclude arguments.
// zsh expands unquoted *.js → "no matches found". Wrap in single quotes.
// Only quotes when the value after = contains * and is NOT already quoted.
function quoteGlobPatterns(cmd) {
  return cmd.replace(/(--include|--exclude|--include-from|--exclude-from)=(\S+)/g, (match, flag, value) => {
    // Already quoted? Skip.
    if (value.startsWith("'") || value.startsWith('"')) return match;
    // Contains a glob char? Quote it.
    if (/[*?\[\]{}]/.test(value)) {
      return `${flag}='${value}'`;
    }
    return match;
  });
}

// Claude Code Agent/Task tool requires `description` + `prompt` + optional
// `subagent_type`, `is_background`, `resume`. Non-Anthropic models hallucinate
// various field names: `agent_type` (should be `subagent_type`), `instructions`
// or `task` (should be `prompt`), and frequently omit the required `description`.
// Rename to canonical fields, synthesize `description` if missing, then strip
// any remaining unknown fields so the tool call doesn't get rejected.
function sanitizeAgentArgs(args) {
  if (!("subagent_type" in args) && "agent_type" in args) {
    args.subagent_type = args.agent_type;
    delete args.agent_type;
  }
  if (!("prompt" in args)) {
    if ("instructions" in args) {
      args.prompt = args.instructions;
      delete args.instructions;
    } else if ("task" in args) {
      args.prompt = args.task;
      delete args.task;
    }
  }
  // Claude Code requires `description`. GLM-5.2 often emits only `subagent_type`
  // + `prompt` and forgets `description` → InputValidationError → retry loop →
  // session stuck. Synthesize a short description from the prompt if missing.
  if (!("description" in args) || typeof args.description !== "string" || !args.description.trim()) {
    const source = args.prompt || args.task || args.instructions || args.subagent_type || "Agent task";
    args.description = String(source).slice(0, 80);
  }
  // Claude Code also requires `prompt`. If the model emitted an Agent call
  // without any prompt-like field, synthesize from description so the call
  // lands instead of being rejected.
  if (!("prompt" in args) || typeof args.prompt !== "string" || !args.prompt.trim()) {
    args.prompt = args.description || "Explore and report findings";
  }
  // GLM-5.2 sometimes fills all three fields with the same string (e.g.
  // "general-purpose") — the call lands but the subagent runs with no real
  // task → session idle. Detect this and keep only subagent_type, synthesize
  // description + prompt from the user's last message if available.
  const st = args.subagent_type;
  if (st && args.description === st && args.prompt === st) {
    args.description = `Agent task: ${st}`;
    args.prompt = `Perform the user's requested task using the ${st} profile. Report findings.`;
  }
  // Sonnet 4.6 via windsurf (when toolDefs are missing/corrupted) hallucinates
  // Agent args with description===prompt===generic placeholder like "Agent task"
  // (session 89893ae0). The call lands but the subagent runs with no real task
  // → returns garbage → model emits raw text → end_turn → session stop.
  // Detect this and synthesize a meaningful prompt so the subagent does
  // something useful instead of returning garbage.
  const GENERIC_AGENT_VALUES = new Set([
    "agent task", "task", "do task", "perform task",
    "agent", "subagent", "explore", "search",
  ]);
  const descLower = typeof args.description === "string" ? args.description.toLowerCase().trim() : "";
  const promptLower = typeof args.prompt === "string" ? args.prompt.toLowerCase().trim() : "";
  if (descLower && descLower === promptLower && GENERIC_AGENT_VALUES.has(descLower)) {
    args.description = args.description.charAt(0).toUpperCase() + args.description.slice(1);
    args.prompt = `Explore the codebase and find information relevant to the user's request. Report your findings in detail.`;
  }
  const allowed = new Set(["prompt", "subagent_type", "description", "is_background", "resume"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) delete args[key];
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

// Validate that a tool name looks like a real tool identifier.
// GLM-5.2 sometimes hallucinates a long analysis sentence as the "tool name"
// (e.g. "1. **JWT Expiration Handling Issue**: ..."). Emitting that as a
// tool_use block makes Claude Code reject with "No such tool available" and
// breaks the turn. A valid tool name is a compact identifier — no whitespace,
// no markdown, no prose.
function isValidToolName(name) {
  if (!name || typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (/\s/.test(trimmed)) return false;          // no spaces/newlines
  if (/[*#`]/.test(trimmed)) return false;        // no markdown
  // Identifier-like: letters, digits, _, -, :, . (MCP tools use __ and :)
  if (!/^[A-Za-z_][A-Za-z0-9_\-:.]*$/.test(trimmed)) return false;
  // GLM-5.2 sometimes uses its own model name as the tool name (e.g.
  // "glm-5-2", "claude-sonnet-4-6") — repeating it hundreds of times in
  // a loop. Reject any name that starts with a known model family prefix
  // followed by version-like suffix (digits, dashes, dots, letters).
  if (isModelName(trimmed)) return false;
  return true;
}

// Check if a name looks like a model identifier (glm-5-2, claude-sonnet-4-6, etc.)
function isModelName(name) {
  if (!name || typeof name !== "string") return false;
  return /^(glm|gpt|claude|sonnet|haiku|opus|llama|mistral|qwen|deepseek|gemini|swe|devmini)[\-_a-z0-9.]+$/i.test(name.trim());
}

// Helper: emit a tool_use block from GLM inline tool call.
// If the tool name is invalid (hallucinated prose), emit the raw inline text
// instead so nothing is silently dropped and the turn doesn't break.
// Exception: if the tool name is a model name (e.g. "glm-5-2"), the model is
// in a loop emitting the same pattern hundreds of times — suppress the raw
// text entirely to avoid flooding the output with garbage.
function emitGlmToolUse(state, results, toolName, argsJson) {
  // Strip Claude OAuth prefix if present
  let bareName = toolName;
  if (typeof bareName === "string" && bareName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
    bareName = bareName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
  }

  if (!isValidToolName(bareName)) {
    // Model name as tool name → suppress raw text (loop garbage)
    if (isModelName(bareName)) {
      return;
    }
    emitTextSegment(state, results, `[TOOL_CALLS]${toolName}[TOOL_CALLS]${argsJson}`);
    return;
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
    // No partial marker — check for raw commands (F27) before emitting
    const rawCmd = detectRawCommandInText(buf);
    if (rawCmd) {
      if (rawCmd.beforeText) emitTextSegment(state, results, rawCmd.beforeText);
      emitGlmToolUse(state, results, rawCmd.toolName, rawCmd.argsJson);
      state.glmTextBuffer = rawCmd.afterText;
      return true; // loop to process remaining text
    }
    // No raw command found — emit everything
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
  if (!m2) {
    // F25: Single marker + JSON object directly after = missing tool name.
    // Sonnet via Cascade emits: [TOOL_CALLS]{"command":"ls -la"} (no tool name).
    // Try to parse JSON and infer tool name from args keys.
    const trimmedAfter = afterMarker.trim();
    if (trimmedAfter.startsWith("{")) {
      const jsonEnd = findJsonEnd(trimmedAfter);
      if (jsonEnd > 0) {
        const argsJson = trimmedAfter.slice(0, jsonEnd);
        const inferred = inferToolNameFromArgs(argsJson);
        if (inferred) {
          emitGlmToolUse(state, results, inferred.name, inferred.argsJson);
          state.glmTextBuffer = trimmedAfter.slice(jsonEnd);
          return true;
        }
      }
    }
    // F31: Orphan [TOOL_CALLS] marker — afterMarker doesn't start with a valid
    // tool name character or JSON. Model emitted code/prose with marker prefix.
    // Strip the marker and emit the text cleanly (don't leak [TOOL_CALLS] garbage).
    // Valid tool name starts with [A-Za-z_], JSON starts with {. Anything else
    // (digit, space, special char, newline) = not a tool call.
    if (trimmedAfter && !/^[A-Za-z_{]/.test(trimmedAfter)) {
      emitTextSegment(state, results, trimmedAfter);
      state.glmTextBuffer = "";
      return true;
    }
    // Incomplete — keep marker + afterMarker so flush-at-finish preserves the
    // original text (no silent drop of the "[TOOL_CALLS]" we already consumed).
    state.glmTextBuffer = marker + afterMarker;
    return false;
  }

  let toolName = afterMarker.slice(0, m2.index);
  let afterSecondMarker = afterMarker.slice(m2.index + m2[0].length);

  // F25: Empty/whitespace tool name + JSON args = missing tool name.
  // Sonnet emits: [TOOL_CALLS]\n[TOOL_CALLS]{"file_path":"/path"} (empty name).
  // Infer tool name from args keys.
  if (!toolName.trim() && afterSecondMarker.trim().startsWith("{")) {
    const jsonEnd = findJsonEnd(afterSecondMarker.trim());
    if (jsonEnd > 0) {
      const argsJson = afterSecondMarker.trim().slice(0, jsonEnd);
      const inferred = inferToolNameFromArgs(argsJson);
      if (inferred) {
        emitGlmToolUse(state, results, inferred.name, inferred.argsJson);
        state.glmTextBuffer = afterSecondMarker.trim().slice(jsonEnd);
        return true;
      }
    }
  }

  // F24: Detect swapped format [TOOL_CALLS]prose[TOOL_CALLS]real_tool_name{args}
  // Sonnet/Claude via Cascade sometimes put explanation text as the "tool name"
  // and the real tool name after the second marker.
  // Pattern: [TOOL_CALLS]I'll help you...[TOOL_CALLS]Grep{"pattern":"mcp"}
  // Detect: toolName has whitespace (prose) + afterSecondMarker starts with
  // a valid compact identifier → emit prose as text, swap tool name.
  if (/\s/.test(toolName.trim()) && toolName.trim().length > 15) {
    const swapMatch = afterSecondMarker.match(/^([A-Za-z_][A-Za-z0-9_\-:.]*)([\s\S]*)/);
    if (swapMatch && swapMatch[1] && !/\s/.test(swapMatch[1]) && swapMatch[1].length <= 64) {
      emitTextSegment(state, results, toolName.trim());
      toolName = swapMatch[1];
      afterSecondMarker = swapMatch[2];
      // After swap, if no args remain, emit tool call with empty args
      if (!afterSecondMarker.trim()) {
        emitGlmToolUse(state, results, toolName, "{}");
        state.glmTextBuffer = "";
        return true;
      }
    }
  }

  // F22: Windsurf returns [TOOL_CALLS] with non-JSON args for Sonnet/Claude too
  // (not just GLM). E.g. [TOOL_CALLS]rg[TOOL_CALLS]"devin" or
  // [TOOL_CALLS]rg[TOOL_CALLS]rg "mcp" --max-results 10. Map windsurf tool
  // names to Claude Code tool names and synthesize JSON args from raw text.
  const WINDSURF_TOOL_MAP = {
    rg: "Grep", grep: "Grep", search: "Grep",
    bash: "Bash", shell: "Bash", sh: "Bash",
    read: "Read", cat: "Read", view: "Read",
    edit: "Edit", replace: "Edit",
    write: "Write", create: "Write",
    find: "Glob", glob: "Glob",
    agent: "Agent", subagent: "Agent", task: "Agent",
  };

  // Find JSON object: starts with { , ends with matching }
  const jsonStart = afterSecondMarker.indexOf("{");
  if (jsonStart === -1) {
    // F28: Model name as tool name with no args (e.g. [TOOL_CALLS]claude-sonnet-4-6[ARGS])
    // Suppress marker garbage, keep remaining text in buffer for next iteration
    if (isModelName(toolName.trim())) {
      state.glmTextBuffer = afterSecondMarker;
      return true; // loop to process remaining text
    }
    if (afterSecondMarker === "" || /^\s*$/.test(afterSecondMarker)) {
      // JSON not started yet — wait for more chunks
      state.glmTextBuffer = marker + afterMarker;
      return false;
    }
    // F22: No JSON args — try to map tool name + synthesize args from raw text
    const mappedName = WINDSURF_TOOL_MAP[toolName.toLowerCase().trim()];
    if (mappedName) {
      const rawArgs = afterSecondMarker.trim().replace(/<\/s>\s*$/, "").trim();
      let synthArgs;
      if (mappedName === "Grep") {
        // Extract quoted pattern first: rg "mcp" --max-results 10 → mcp
        // Or unquoted first token if no quotes: devin → devin
        const quotedMatch = rawArgs.match(/["']([^"']+)["']/);
        const pattern = quotedMatch
          ? quotedMatch[1]
          : rawArgs.replace(/^(rg|grep|search)\s+/i, "").split(/\s+/)[0] || rawArgs;
        synthArgs = JSON.stringify({ pattern: pattern });
      } else if (mappedName === "Bash") {
        synthArgs = JSON.stringify({ command: rawArgs });
      } else if (mappedName === "Read") {
        synthArgs = JSON.stringify({ file_path: rawArgs.replace(/^["']|["']$/g, "") });
      } else if (mappedName === "Glob") {
        synthArgs = JSON.stringify({ pattern: rawArgs.replace(/^["']|["']$/g, "") });
      } else if (mappedName === "Agent") {
        synthArgs = JSON.stringify({ description: rawArgs.slice(0, 80), prompt: rawArgs });
      } else {
        synthArgs = JSON.stringify({ input: rawArgs });
      }
      emitGlmToolUse(state, results, mappedName, synthArgs);
      state.glmTextBuffer = "";
      return true;
    }
    // Malformed (no JSON, no map) — emit as text and move on
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

  // Emit tool_use block
  emitGlmToolUse(state, results, toolName, argsJson);

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

    // Override stop_reason when GLM emitted inline tool_use blocks.
    // GLM-5.2 emits [TOOL_CALLS] as text → Windsurf returns finish_reason="stop"
    // → convertFinishReason("stop") = "end_turn". But Claude Code needs
    // stop_reason="tool_use" to trigger tool execution. Without this override,
    // Claude Code sees "end_turn" + tool_use block → stops without executing
    // the tool → session idle → "dừng đột ngột".
    const hasGlmToolUse = [...state.toolCalls.values()].some(t => t.glmEmitted);
    const stopReason = hasGlmToolUse
      ? "tool_use"
      : convertFinishReason(choice.finish_reason);

    // Use tracked usage (will be estimated in stream.js if not valid)
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
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
