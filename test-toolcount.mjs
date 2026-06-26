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
  const len = raw.readUInt32BE(1);
  const payload = raw.subarray(5, 5 + len);
  try {
    const unzipped = gunzipSync(payload);
    const strings = extractStrings(unzipped);
    const text = strings.join("");
    const hasMarker = text.includes("[TOOL_CALLS]");
    const hasName = /\[TOOL_CALLS\][A-Za-z_][A-Za-z0-9_:]*\[TOOL_CALLS\]|\[TOOL_CALLS\][A-Za-z_][A-Za-z0-9_:]*\[ARGS\]/.test(text);
    console.log(`${label}: marker=${hasMarker} name=${hasName}`);
    console.log(`  text: ${text.slice(0,200)}`);
    return { hasMarker, hasName, text };
  } catch (e) {
    console.log(`${label}: GUNZIP_FAIL ${e.message}`);
    return null;
  }
}

const toolInstruction =
  `You are an agent. Use tools to accomplish the user's task. Do NOT echo or repeat the user's message.\n\n` +
  `Available tools: ${"%TOOLS%"}\n\n` +
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

const messages = [
  { role: 5, content: "You are Claude Code. Use tools. Reply in Vietnamese." },
  { role: 1, content: "dùng Bash tool chạy: grep -r console --include=*.js /tmp/edge-test" },
];

// Test with 3, 10, 20, 30 tools
const toolsets = {
  "3 tools": ["Read","Bash","Agent"],
  "10 tools": ["Read","Bash","Agent","Edit","Write","Grep","Glob","WebFetch","WebSearch","NotebookRead"],
  "20 tools": ["Read","Bash","Agent","Edit","Write","Grep","Glob","WebFetch","WebSearch","NotebookRead","NotebookEdit","TodoWrite","AskUserQuestion","ListMcpServers","McpCallTool","McpListTools","McpReadResource","RunSubagent","ReadSubagent","KillShell"],
  "30 tools": ["Read","Bash","Agent","Edit","Write","Grep","Glob","WebFetch","WebSearch","NotebookRead","NotebookEdit","TodoWrite","AskUserQuestion","ListMcpServers","McpCallTool","McpListTools","McpReadResource","RunSubagent","ReadSubagent","KillShell","GetOutput","WriteToProcess","RequestScope","FindFileByName","Skill","CloudHandoff","Exec","NotebookEdit","Task","TaskUpdate"],
};

for (const [label, tools] of Object.entries(toolsets)) {
  const toolDefsJson = JSON.stringify(tools.map(n => ({name:n, description:`${n} tool`, schema:{}})));
  const sysContent = toolInstruction.replace("%TOOLS%", tools.join(", "));
  const msgs = [{ role: 5, content: sysContent }, { role: 1, content: "dùng Bash tool chạy: grep -r console --include=*.js /tmp/edge-test" }];
  console.log(`\n=== ${label} (${tools.length} tools) ===`);
  for (let i = 1; i <= 3; i++) {
    await send(`  run ${i}`, msgs, toolDefsJson, "glm-5-2");
  }
}
