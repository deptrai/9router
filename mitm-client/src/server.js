// Standalone MITM TLS server — listens on :443, intercepts tool traffic,
// forwards to remote 9router (configured via user config).
const https = require("https");
const http2 = require("http2");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const dns = require("dns");
const { promisify } = require("util");
const { execSync } = require("child_process");
const { log, err, dumpRequest, createResponseDumper, clearDumpDir, enableServerLogFile } = require("./logger");
const { TARGET_HOSTS, URL_PATTERNS, MODEL_SYNONYMS, MODEL_PATTERNS, getToolForHost } = require("./mitmConfig");
const { DATA_DIR, MITM_DIR } = require("./paths");
const { getCertForDomain } = require("./cert/rootCA");
const { loadConfig } = require("./config");

const LOCAL_PORT = 443;
const IS_WIN = process.platform === "win32";

const MITM_INSECURE_UPSTREAM = process.env.MITM_INSECURE_UPSTREAM === "1";
const UPSTREAM_REJECT_UNAUTHORIZED = !MITM_INSECURE_UPSTREAM;
const ENABLE_FILE_LOG = loadConfig().mitmDebug === true;

// AC2 — in-memory connection stats (reset on every server start, not persisted).
const stats = { active: 0, total: 0, success: 0, error: 0 };
function getStats() { return { ...stats }; }

// Clear stale dump files on every MITM start
clearDumpDir();
const INTERNAL_REQUEST_HEADER = { name: "x-request-source", value: "local" };

const HOST_REWRITE = {
  "cloudcode-pa.googleapis.com": "daily-cloudcode-pa.googleapis.com",
};

const handlers = {
  antigravity: null, // not supported in standalone (needs dbReader)
  copilot: null,
  kiro: null,
  cursor: null,
  windsurf: require("./handlers/windsurf"),
};

// ── SSL / SNI ─────────────────────────────────────────────────

const certCache = new Map();
let rootCAPem;

function sniCallback(servername, cb) {
  try {
    if (certCache.has(servername)) return cb(null, certCache.get(servername));
    const certData = getCertForDomain(servername);
    if (!certData) return cb(new Error(`Failed to generate cert for ${servername}`));
    const ctx = tls.createSecureContext({
      key: certData.key,
      cert: `${certData.cert}\n${rootCAPem}`
    });
    certCache.set(servername, ctx);
    cb(null, ctx);
  } catch (e) {
    err(`SNI error for ${servername}: ${e.message}`);
    cb(e);
  }
}

let sslOptions;
try {
  const rootKey = fs.readFileSync(path.join(MITM_DIR, "rootCA.key"));
  const rootCert = fs.readFileSync(path.join(MITM_DIR, "rootCA.crt"));
  rootCAPem = rootCert.toString("utf8");
  sslOptions = { key: rootKey, cert: rootCert, SNICallback: sniCallback };
} catch (e) {
  err(`Root CA not found: ${e.message}. Run: mitm-client setup`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────

const cachedTargetIPs = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveTargetIP(hostname) {
  const cached = cachedTargetIPs[hostname];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.ip;
  const resolver = new dns.Resolver();
  resolver.setServers(["8.8.8.8"]);
  const resolve4 = promisify(resolver.resolve4.bind(resolver));
  const addresses = await resolve4(hostname);
  // P9: guard empty DNS response — prevent caching undefined IP.
  if (!addresses || addresses.length === 0) throw new Error(`DNS resolution failed for ${hostname}`);
  cachedTargetIPs[hostname] = { ip: addresses[0], ts: Date.now() };
  return cachedTargetIPs[hostname].ip;
}

function collectBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractModel(url, body) {
  const urlMatch = url.match(/\/models\/([^/:]+)/);
  if (urlMatch) return urlMatch[1];
  try {
    const parsed = JSON.parse(body.toString());
    if (parsed.conversationState) {
      return parsed.conversationState.currentMessage?.userInputMessage?.modelId || null;
    }
    return parsed.model || null;
  } catch { return null; }
}

async function passthrough(req, res, bodyBuffer, onResponse) {
  const originalHost = (req.headers.host || TARGET_HOSTS[0]).split(":")[0];
  const isChatEndpoint = req.url.includes(":generateContent") || req.url.includes(":streamGenerateContent");
  const targetHost = isChatEndpoint ? (HOST_REWRITE[originalHost] || originalHost) : originalHost;
  const dumper = ENABLE_FILE_LOG ? createResponseDumper(req, "passthrough") : null;

  const headersForForwarding = { ...req.headers, host: targetHost };

  try {
    const proto = await negotiateAlpn(targetHost);
    if (proto === "h2") {
      return await passthroughHttp2(req, res, bodyBuffer, headersForForwarding, targetHost, onResponse, dumper);
    }
  } catch (e) {
    err(`[mitm] ALPN negotiate failed: ${e.message}, fallback to HTTP/1.1`);
  }

  return passthroughHttps(req, res, bodyBuffer, headersForForwarding, targetHost, onResponse, dumper);
}

const alpnCache = new Map();
async function negotiateAlpn(host) {
  if (alpnCache.has(host)) return alpnCache.get(host);
  const ip = await resolveTargetIP(host);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: ip, port: 443, servername: host,
      ALPNProtocols: ["h2", "http/1.1"], rejectUnauthorized: UPSTREAM_REJECT_UNAUTHORIZED,
    }, () => {
      const proto = socket.alpnProtocol || "http/1.1";
      alpnCache.set(host, proto);
      log(`🔗 [mitm] ALPN ${host} → ${proto}`);
      socket.end();
      resolve(proto);
    });
    socket.once("error", reject);
    socket.setTimeout(5000, () => { socket.destroy(new Error("ALPN timeout")); });
  });
}

async function passthroughHttp2(req, res, bodyBuffer, headers, targetHost, onResponse, dumper) {
  const targetIP = await resolveTargetIP(targetHost);
  const h2Headers = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "keep-alive" ||
        lk === "transfer-encoding" || lk === "upgrade" || lk === "proxy-connection") continue;
    h2Headers[lk] = v;
  }
  h2Headers[":method"] = req.method;
  h2Headers[":path"] = req.url;
  h2Headers[":scheme"] = "https";
  h2Headers[":authority"] = targetHost;

  return new Promise((resolve) => {
    const client = http2.connect(`https://${targetHost}`, {
      createConnection: () => tls.connect({
        host: targetIP, port: 443, servername: targetHost,
        ALPNProtocols: ["h2"], rejectUnauthorized: UPSTREAM_REJECT_UNAUTHORIZED,
      }),
    });
    client.once("error", (e) => {
      err(`[mitm] http2 client error: ${e.message}`);
      if (dumper) { dumper.writeChunk(`\n[ERROR h2] ${e.message}\n`); dumper.end(); }
      if (!res.headersSent) res.writeHead(502);
      if (!res.writableEnded) res.end("Bad Gateway");
      try { client.close(); } catch {}
      resolve();
    });

    const stream = client.request(h2Headers, { endStream: bodyBuffer.length === 0 });
    if (bodyBuffer.length > 0) stream.end(bodyBuffer);

    stream.once("response", (responseHeaders) => {
      const status = responseHeaders[":status"];
      const outHeaders = {};
      for (const [k, v] of Object.entries(responseHeaders)) {
        if (k.startsWith(":")) continue;
        if (k === "connection" || k === "keep-alive" || k === "transfer-encoding") continue;
        outHeaders[k] = v;
      }
      res.writeHead(status, outHeaders);
      if (dumper) dumper.writeHeader(status, outHeaders);

      const chunks = [];
      stream.on("data", chunk => {
        if (dumper) dumper.writeChunk(chunk);
        if (onResponse) chunks.push(chunk);
        res.write(chunk);
      });
      stream.on("end", () => {
        if (dumper) dumper.end();
        if (!res.writableEnded) res.end();
        if (onResponse) try { onResponse(Buffer.concat(chunks), outHeaders); } catch {}
        try { client.close(); } catch {}
        resolve();
      });
    });
    stream.once("error", (e) => {
      err(`[mitm] http2 stream error: ${e.message}`);
      if (dumper) { dumper.writeChunk(`\n[ERROR h2-stream] ${e.message}\n`); dumper.end(); }
      if (!res.headersSent) res.writeHead(502);
      if (!res.writableEnded) res.end();
      try { client.close(); } catch {}
      resolve();
    });
  });
}

async function passthroughHttps(req, res, bodyBuffer, headers, targetHost, onResponse, dumper) {
  const targetIP = await resolveTargetIP(targetHost);
  const forwardReq = https.request({
    hostname: targetIP,
    port: 443,
    path: req.url,
    method: req.method,
    headers,
    servername: targetHost,
    rejectUnauthorized: UPSTREAM_REJECT_UNAUTHORIZED
  }, (forwardRes) => {
    res.writeHead(forwardRes.statusCode, forwardRes.headers);
    if (dumper) dumper.writeHeader(forwardRes.statusCode, forwardRes.headers);

    if (!onResponse && !dumper) {
      forwardRes.pipe(res);
      return;
    }

    const chunks = [];
    forwardRes.on("data", chunk => {
      if (dumper) dumper.writeChunk(chunk);
      if (onResponse) chunks.push(chunk);
      res.write(chunk);
    });
    forwardRes.on("end", () => {
      if (dumper) dumper.end();
      res.end();
      if (onResponse) try { onResponse(Buffer.concat(chunks), forwardRes.headers); } catch { /* ignore */ }
    });
  });

  forwardReq.on("error", (e) => {
    err(`Passthrough error: ${e.message}`);
    if (dumper) { dumper.writeChunk(`\n[ERROR] ${e.message}\n`); dumper.end(); }
    if (!res.headersSent) res.writeHead(502);
    // P4: guard against double res.end() when headers already sent.
    if (!res.writableEnded) res.end("Bad Gateway");
  });

  if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer);
  forwardReq.end();
}

// ── Request handler ───────────────────────────────────────────

const server = https.createServer(sslOptions, async (req, res) => {
  try {
    if (req.url === "/_mitm_health") {
      const remote = req.socket.remoteAddress;
      if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: process.pid, stats: getStats() }));
      return;
    }

    // AC2 — track request lifecycle: active++ on enter, total++ on enter,
    // success/error++ on response finish based on status code.
    stats.active++;
    stats.total++;
    const cleanup = () => {
      if (stats.active > 0) stats.active--;
    };
    res.on("finish", () => {
      const code = res.statusCode || 0;
      if (code >= 200 && code < 400) stats.success++;
      else stats.error++;
      cleanup();
    });
    res.on("close", cleanup);

    const bodyBuffer = await collectBodyRaw(req);
    if (ENABLE_FILE_LOG) dumpRequest(req, bodyBuffer, "raw");

    if (req.headers[INTERNAL_REQUEST_HEADER.name] === INTERNAL_REQUEST_HEADER.value) {
      return passthrough(req, res, bodyBuffer);
    }

    const tool = getToolForHost(req.headers.host);
    if (!tool) return passthrough(req, res, bodyBuffer);

    const patterns = URL_PATTERNS[tool] || [];
    const isChat = patterns.some(p => req.url.includes(p));
    if (!isChat) return passthrough(req, res, bodyBuffer);

    // Windsurf/Cursor use binary proto — delegate to handler (no model extraction at this layer).
    if (tool === "cursor" || tool === "windsurf") {
      const handler = handlers[tool];
      if (!handler) return passthrough(req, res, bodyBuffer);
      return handler.intercept(req, res, bodyBuffer, null, passthrough);
    }

    // Other tools (antigravity/copilot/kiro) not supported in standalone client yet.
    return passthrough(req, res, bodyBuffer);
  } catch (e) {
    err(`Unhandled error: ${e.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.message, type: "mitm_error" } }));
  }
});

function killPort(port) {
  try {
    if (IS_WIN) {
      const psCmd = `powershell -NonInteractive -WindowStyle Hidden -Command ` +
        `"Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`;
      const out = execSync(psCmd, { encoding: "utf-8", windowsHide: true }).trim();
      if (!out) return;
      const pidList = out.split(/\r?\n/).map(s => s.trim()).filter(p => p && Number(p) !== process.pid && Number(p) > 4);
      pidList.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { windowsHide: true }); } catch {} });
    } else {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: "utf-8", windowsHide: true }).trim();
      if (!out) return;
      const pidList = out.split("\n").filter(p => p && Number(p) !== process.pid);
      pidList.forEach(pid => { try { process.kill(Number(pid), "SIGKILL"); } catch (e) { err(`Failed to kill PID ${pid}: ${e.message}`); } });
    }
    log(`Killed process(es) on port ${port}`);
  } catch (e) {
    if (e.status !== 1) throw e;
  }
}

function start() {
  // AC1 — enable server log file so TUI can tail live logs.
  enableServerLogFile();
  try { killPort(LOCAL_PORT); } catch (e) {
    err(`Cannot kill process on port ${LOCAL_PORT}: ${e.message}`);
    process.exit(1);
  }

  server.listen(LOCAL_PORT, () => log(`🚀 Server ready on :${LOCAL_PORT} → router: ${loadConfig().routerUrl}`));

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") err(`Port ${LOCAL_PORT} already in use`);
    else if (e.code === "EACCES") err(`Permission denied for port ${LOCAL_PORT} (run as root/sudo)`);
    else err(e.message);
    process.exit(1);
  });

  const { removeAllDNSEntriesSync } = require("./dns/dnsConfig");
  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    removeAllDNSEntriesSync();
    const forceExit = setTimeout(() => process.exit(0), 1500);
    server.close(() => { clearTimeout(forceExit); process.exit(0); });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = { start, server, passthrough, getStats };
