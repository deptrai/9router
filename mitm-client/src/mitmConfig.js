// MITM routing config — host → tool mapping + URL patterns.
// Standalone copy of src/mitm/config.js (no Next.js / 9router deps).

const TARGET_HOSTS = [
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "api2.cursor.sh",
  "server.codeium.com",
];

const URL_PATTERNS = {
  antigravity: [":generateContent", ":streamGenerateContent"],
  copilot: ["/chat/completions", "/v1/messages", "/responses"],
  kiro: ["/generateAssistantResponse"],
  cursor: ["/BidiAppend", "/RunSSE", "/RunPoll", "/Run"],
  windsurf: ["/exa.api_server_pb.ApiServerService/GetChatMessage"],
};

const MODEL_SYNONYMS = {
  antigravity: {
    "gemini-default": "gemini-3.5-flash-low",
    "gemini-3.1-pro-high": "gemini-pro-agent",
    "gemini-3-pro-high": "gemini-pro-agent",
    "gemini-3-pro-low": "gemini-3.1-pro-low",
  },
};

const MODEL_PATTERNS = {
  antigravity: [
    { match: /flash.*low|low.*flash|flash.*medium|medium.*flash/i, alias: "gemini-3.5-flash-low" },
    { match: /flash.*agent|agent.*flash|flash/i, alias: "gemini-3-flash-agent" },
    { match: /pro.*low|low.*pro/i, alias: "gemini-3.1-pro-low" },
    { match: /gemini.*pro|pro.*gemini/i, alias: "gemini-pro-agent" },
    { match: /opus/i, alias: "claude-opus-4-6-thinking" },
    { match: /sonnet|claude/i, alias: "claude-sonnet-4-6" },
    { match: /gpt.*oss|oss/i, alias: "gpt-oss-120b-medium" },
  ],
};

const LOG_BLACKLIST_URL_PARTS = [
  "recordCodeAssistMetrics",
  "recordTrajectoryAnalytics",
  "fetchAdminControls",
  "listExperiments",
  "fetchUserInfo",
];

function getToolForHost(host) {
  const h = (host || "").split(":")[0];
  if (h === "api.individual.githubcopilot.com") return "copilot";
  if (h === "daily-cloudcode-pa.googleapis.com" || h === "cloudcode-pa.googleapis.com") return "antigravity";
  if (h === "q.us-east-1.amazonaws.com") return "kiro";
  if (h === "api2.cursor.sh") return "cursor";
  if (h === "server.codeium.com") return "windsurf";
  return null;
}

// Per-tool DNS hosts written to /etc/hosts as 127.0.0.1
const TOOL_HOSTS = {
  antigravity: ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"],
  copilot: ["api.individual.githubcopilot.com"],
  kiro: ["q.us-east-1.amazonaws.com", "codewhisperer.us-east-1.amazonaws.com"],
  cursor: ["api2.cursor.sh"],
  windsurf: ["server.codeium.com"],
};

module.exports = {
  TARGET_HOSTS, URL_PATTERNS, MODEL_SYNONYMS, MODEL_PATTERNS,
  LOG_BLACKLIST_URL_PARTS, getToolForHost, TOOL_HOSTS,
};
