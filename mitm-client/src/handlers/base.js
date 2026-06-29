// fetchRouter — forward translated body to REMOTE 9router instance.
// Differs from src/mitm/handlers/base.js: reads routerUrl + apiKey from user config
// (not env), so multiple local machines can point at the same production 9router.
const { loadConfig } = require("../config");

const STRIP_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding",
  "content-type", "authorization"
]);

// P6: Validate routerUrl — reject non-http(s) protocols to prevent SSRF.
function validateRouterUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return url;
  } catch { return null; }
}

async function fetchRouter(openaiBody, path = "/v1/chat/completions", clientHeaders = {}) {
  const cfg = loadConfig();
  const rawUrl = String(cfg.routerUrl || "http://localhost:20128").trim().replace(/\/+$/, "") || "http://localhost:20128";
  // P6: validate URL before use
  const routerBase = validateRouterUrl(rawUrl) || "http://localhost:20128";

  const forwarded = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) forwarded[k] = v;
  }

  // P2: 5min timeout for streaming requests (Windsurf with 54+ messages + 23 tools
  // can stream >30s). 30s timeout only for non-streaming requests.
  const isStreaming = openaiBody?.stream === true;
  const timeoutMs = isStreaming ? 300000 : 30000;
  const response = await fetch(`${routerBase}${path}`, {
    method: "POST",
    headers: {
      ...forwarded,
      "Content-Type": "application/json",
      ...(cfg.apiKey && { "Authorization": `Bearer ${cfg.apiKey}` })
    },
    body: JSON.stringify(openaiBody),
    signal: AbortSignal.timeout(timeoutMs),
  });

  return response;
}

async function pipeSSE(routerRes, res, dumper) {
  const ct = routerRes.headers.get("content-type") || "application/json";
  const status = routerRes.status || 200;
  const resHeaders = { "Content-Type": ct, "Cache-Control": "no-cache", "Connection": "keep-alive" };
  if (ct.includes("text/event-stream")) resHeaders["X-Accel-Buffering"] = "no";
  res.writeHead(status, resHeaders);
  if (dumper) dumper.writeHeader(routerRes.status, Object.fromEntries(routerRes.headers));

  if (!routerRes.body) {
    const text = await routerRes.text().catch(() => "");
    if (dumper) { dumper.writeChunk(text); dumper.end(); }
    res.end(text);
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder();
  // P3: 5min idle timeout — prevent infinite stream from hanging client.
  let idleTimer = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try { reader.cancel(); } catch {}
      if (!res.writableEnded) res.end();
    }, 300000);
  };
  resetIdleTimer();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { if (dumper) dumper.end(); res.end(); break; }
      resetIdleTimer();
      if (dumper) dumper.writeChunk(value);
      res.write(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

module.exports = { fetchRouter, pipeSSE };
