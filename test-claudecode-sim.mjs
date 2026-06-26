import { getCachedJwt, _buildRequest, _streamingRequest, extractKey } from "./open-sse/utils/windsurfAuth.js";
import { extractStrings } from "./open-sse/utils/windsurfProtobuf.js";
import { gunzipSync } from "node:zlib";

const keyResult = await extractKey();
const apiKey = keyResult.api_key;
const jwt = await getCachedJwt(apiKey);

async function send(label, messages, toolDefs, model) {
  const protoBytes = _buildRequest(apiKey, jwt, messages, toolDefs, model);
  const resp = await _streamingRequest(protoBytes, 60000, 2);
  const reader = resp.body.getReader();
  let rawChunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rawChunks.push(value);
  }
  const raw = Buffer.concat(rawChunks);
  if (raw.length < 10) { console.log(`${label}: TOO_SHORT`); return; }
  const len = raw.readUInt32BE(1);
  const payload = raw.subarray(5, 5 + len);
  try {
    const unzipped = gunzipSync(payload);
    const strings = extractStrings(unzipped);
    const text = strings.join("");
    const hasName = /\[TOOL_CALLS\][A-Za-z_][A-Za-z0-9_:]*\[TOOL_CALLS\]|\[TOOL_CALLS\][A-Za-z_][A-Za-z0-9_:]*\[ARGS\]/.test(text);
    console.log(`${label}: name=${hasName}`);
    console.log(`  text: ${text.slice(0,250)}`);
  } catch (e) {
    console.log(`${label}: GUNZIP_FAIL ${e.message}`);
  }
}

// Simulate Claude Code's actual system prompt (much longer)
const claudeCodeSystemPrompt = `You are Claude Code, Anthropic's official CLI for Claude. You are an interactive command line agent.

# Modes
The active mode is how the user would like you to act.
- Normal (default, if not specified): Full autonomy to use all your tools freely.

# Style
## Tone
- Be concise, direct, and to the point.
- Output text to communicate with the user; all text you output outside of tool use is displayed to the user.

## Proactiveness
You are allowed to be proactive, but only when the user asks you to do something.

# Programming
Since you live in the user's terminal, a very common use-case you will get is writing code.

## Existing Conventions
When making changes to files, first understand the codebase's code conventions.

## Code style
- IMPORTANT: Do NOT add or remove comments unless asked!
- Default to writing compact code.

# Git
### Creating commits
1. Run in parallel: git status, git diff, git log
2. Draft a concise commit message focusing on "why" not "what".

# Safety
IMPORTANT: Assist with defensive security tasks only.

# Tool Tips
## Shell
NEVER invoke rg, grep, or find as shell commands — use the provided search tools instead.`;

const toolInstruction =
  `You are an agent. Use tools to accomplish the user's task. Do NOT echo or repeat the user's message.\n\n` +
  `Available tools: Read, Bash, Agent, Edit, Write, Grep, Glob, WebFetch, WebSearch, NotebookRead, NotebookEdit, TodoWrite, AskUserQuestion, ListMcpServers, McpCallTool, McpListTools, McpReadResource, RunSubagent, ReadSubagent, KillShell, GetOutput, WriteToProcess, RequestScope, FindFileByName, Skill, CloudHandoff, Exec\n\n` +
  `To call a tool, output this exact format on its own line (no markdown, no backticks):\n` +
  `[TOOL_CALLS]<tool_name>[TOOL_CALLS]{<json_arguments>}\n` +
  `Example: [TOOL_CALLS]Read[TOOL_CALLS]{"file_path":"/tmp/foo.txt"}\n\n` +
  `Rules:\n` +
  `- Args MUST be a valid JSON object matching the tool's expected fields.\n` +
  `- ONLY use tool names from the list above. NEVER use your model name as a tool name.\n` +
  `- Do NOT echo or repeat the user's request. Act on it directly.\n` +
  `- For the Agent tool: subagent_type must be a real profile name (e.g. "Explore", "general", "subagent_general"), description must be a short title of the task, and prompt must be the FULL task instruction. NEVER use the same string for all three fields.\n` +
  `- For the Bash tool: the shell is zsh, NOT bash. ALWAYS quote glob patterns: use --include='*.js' NOT --include=*.js, use --exclude='*' NOT --exclude=*. Unquoted globs will be expanded by zsh and fail with "no matches found".\n` +
  `- For the Bash tool: NEVER run grep -r on a large directory (home, /, /Users) without --exclude-dir. Always exclude: --exclude-dir={.git,node_modules,.next,dist,build,vendor,target,Library,.cache}. For searching a specific project, cd into it first and grep only that directory.\n`;

// Tool defs with FULL schemas (like Claude Code sends)
const toolsWithSchemas = [
  {name:"Read",description:"Reads a file from the local filesystem.",schema:{type:"object",properties:{file_path:{type:"string",description:"The absolute path to the file to read."},offset:{type:"integer"},limit:{type:"integer"}},required:["file_path"]}},
  {name:"Bash",description:"Executes a given shell command.",schema:{type:"object",properties:{command:{type:"string"},run_in_background:{type:"boolean"},timeout:{type:"integer"},shell_id:{type:"string"}},required:["command"]}},
  {name:"Agent",description:"Launch an independent subagent.",schema:{type:"object",properties:{subagent_type:{type:"string"},description:{type:"string"},prompt:{type:"string"},is_background:{type:"boolean"}},required:["description","prompt"]}},
  {name:"Edit",description:"Performs exact string replacements in files.",schema:{type:"object",properties:{file_path:{type:"string"},old_string:{type:"string"},new_string:{type:"string"},replace_all:{type:"boolean"}},required:["file_path","old_string","new_string"]}},
  {name:"Write",description:"Write content to a file.",schema:{type:"object",properties:{file_path:{type:"string"},content:{type:"string"}},required:["file_path","content"]}},
  {name:"Grep",description:"A powerful search tool built on ripgrep.",schema:{type:"object",properties:{pattern:{type:"string"},path:{type:"string"},glob_pattern:{type:"string"},output_mode:{type:"string"}},required:["pattern"]}},
  {name:"Glob",description:"Fast file name/path pattern matching tool.",schema:{type:"object",properties:{pattern:{type:"string"},path:{type:"string"}},required:["pattern"]}},
  {name:"WebFetch",description:"Fetches a web page.",schema:{type:"object",properties:{url:{type:"string"}},required:["url"]}},
  {name:"WebSearch",description:"Search the web.",schema:{type:"object",properties:{query:{type:"string"}},required:["query"]}},
  {name:"TodoWrite",description:"Manage a structured task list.",schema:{type:"object",properties:{todos:{type:"array"}},required:["todos"]}},
];

const toolDefsJson = JSON.stringify(toolsWithSchemas);

// Scenario 1: 9router injection + Claude Code system (prepended)
const msgs1 = [
  { role: 5, content: toolInstruction + "\n\n" + claudeCodeSystemPrompt },
  { role: 1, content: "dùng Bash tool chạy: grep -r console --include=*.js /tmp/edge-test" },
];

// Scenario 2: Claude Code system first, then 9router injection (appended — wrong order)
const msgs2 = [
  { role: 5, content: claudeCodeSystemPrompt + "\n\n" + toolInstruction },
  { role: 1, content: "dùng Bash tool chạy: grep -r console --include=*.js /tmp/edge-test" },
];

// Scenario 3: Two system messages (Claude Code sends multiple)
const msgs3 = [
  { role: 5, content: claudeCodeSystemPrompt },
  { role: 5, content: toolInstruction },
  { role: 1, content: "dùng Bash tool chạy: grep -r console --include=*.js /tmp/edge-test" },
];

console.log("=== Scenario 1: injection prepended + Claude Code system ===");
for (let i = 1; i <= 3; i++) await send(`  run ${i}`, msgs1, toolDefsJson, "glm-5-2");

console.log("\n=== Scenario 2: Claude Code system + injection appended ===");
for (let i = 1; i <= 3; i++) await send(`  run ${i}`, msgs2, toolDefsJson, "glm-5-2");

console.log("\n=== Scenario 3: Two separate system messages ===");
for (let i = 1; i <= 3; i++) await send(`  run ${i}`, msgs3, toolDefsJson, "glm-5-2");
