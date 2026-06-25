/**
 * Windsurf auth utility — JWT fetch, cache, rate limit check, request building.
 *
 * Ported from deepgrep/src/core.mjs and deepgrep/src/extract-key.mjs
 * for 9router WindsurfExecutor integration.
 */

import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { platform, arch, release, version as osVersion, hostname, cpus, totalmem } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import initSqlJs from "sql.js";

import {
  ProtobufEncoder,
  extractStrings,
} from "./windsurfProtobuf.js";

// ─── Protocol Constants ────────────────────────────────────

const API_BASE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService";
const AUTH_BASE = "https://server.self-serve.windsurf.com/exa.auth_pb.AuthService";
const WS_APP = "windsurf";
const WS_APP_VER = process.env.WS_APP_VER || "1.48.2";
const WS_LS_VER = process.env.WS_LS_VER || "1.9544.35";
const WS_MODEL = process.env.WS_MODEL || "MODEL_SWE_1_6_SLOW";

// ─── JWT Cache ─────────────────────────────────────────────

const _jwtCache = new Map();

/**
 * Decode JWT payload and extract expiration time.
 * @param {string} jwt
 * @returns {number} expiration timestamp in seconds
 */
function _getJwtExp(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return payload.exp || 0;
  } catch {
    return 0;
  }
}

/**
 * Get a cached or fresh JWT token.
 * Refreshes when token expires or is within 60s of expiration.
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
export async function getCachedJwt(apiKey) {
  const now = Math.floor(Date.now() / 1000);
  const cached = _jwtCache.get(apiKey);
  if (cached && cached.expiresAt > now + 60) return cached.token;
  const token = await fetchJwt(apiKey);
  const exp = _getJwtExp(token);
  // F16: Reject malformed JWT (exp must be > 0)
  if (!exp || exp <= now) {
    throw new Error("Invalid JWT: missing or expired exp claim");
  }
  _jwtCache.set(apiKey, { token, expiresAt: exp });
  return token;
}

/**
 * Invalidate cached JWT for an apiKey (F15).
 * Call on 401 from upstream to force re-fetch on next request.
 */
export function invalidateJwt(apiKey) {
  _jwtCache.delete(apiKey);
}

// ─── TLS Security ──────────────────────────────────────────
// F3: Removed _applyTlsFallback — process-wide NODE_TLS_REJECT_UNAUTHORIZED=0
// is a security hazard in multi-tenant server. TLS errors propagate normally.

// ─── Network Layer ─────────────────────────────────────────

/**
 * Standard unary HTTP POST with proto content type.
 * @param {string} url
 * @param {Buffer} protoBytes
 * @param {boolean} [compress=true]
 * @param {AbortSignal} [callerSignal] - F7: forwarded from executor
 * @returns {Promise<Buffer>}
 */
async function _unaryRequest(url, protoBytes, compress = true, callerSignal) {
  const headers = {
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
    "User-Agent": "connect-go/1.18.1 (go1.25.5)",
    "Accept-Encoding": "gzip",
  };

  let body;
  if (compress) {
    body = gzipSync(protoBytes);
    headers["Content-Encoding"] = "gzip";
  } else {
    body = protoBytes;
  }

  // F7: Merge caller signal with timeout
  const timeoutSignal = AbortSignal.timeout(30000);
  const mergedSignal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: mergedSignal,
  });

  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Connect-RPC streaming POST to GetDevstralStream with retry.
 * D1: True streaming — returns Response object for incremental reading.
 * @param {Buffer} protoBytes
 * @param {number} [timeoutMs=30000]
 * @param {number} [maxRetries=2]
 * @param {AbortSignal} [callerSignal] - F7: forwarded from executor
 * @returns {Promise<Response>} - raw Response for incremental stream reading
 */
export async function _streamingRequest(protoBytes, timeoutMs = 30000, maxRetries = 2, callerSignal) {
  const { connectFrameEncode } = await import("./windsurfProtobuf.js");
  const frame = connectFrameEncode(protoBytes);
  const url = `${API_BASE}/GetDevstralStream`;
  const traceId = randomUUID().replace(/-/g, "");
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  const baseTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 30000;
  const abortMs = baseTimeoutMs + 5000;

  const headers = {
    "Content-Type": "application/connect+proto",
    "Connect-Protocol-Version": "1",
    "Connect-Accept-Encoding": "gzip",
    "Connect-Content-Encoding": "gzip",
    "Connect-Timeout-Ms": String(baseTimeoutMs),
    "User-Agent": "connect-go/1.18.1 (go1.25.5)",
    "Accept-Encoding": "identity",
    "Baggage": `sentry-release=language-server-windsurf@${WS_LS_VER},` +
      `sentry-environment=stable,sentry-sampled=false,` +
      `sentry-trace_id=${traceId},` +
      `sentry-public_key=b813f73488da69eedec534dba1029111`,
    "Sentry-Trace": `${traceId}-${spanId}-0`,
  };

  // F7: Merge caller signal with timeout
  const timeoutSignal = AbortSignal.timeout(abortMs);
  const mergedSignal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: frame,
        signal: mergedSignal,
      });

      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        // Don't retry on 4xx client errors (except 429)
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          throw err;
        }
        lastErr = err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }

      // D1: Return raw Response for true incremental streaming
      return resp;
    } catch (e) {
      lastErr = e;
      // Don't retry on 4xx client errors (except 429)
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) {
        throw e;
      }
      if (e.name === "AbortError") throw e; // F7: don't retry on abort
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr || new Error("Streaming request failed");
}

/**
 * Authenticate with API key to get JWT token.
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
export async function fetchJwt(apiKey) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, WS_APP);
  meta.writeString(2, WS_APP_VER);
  meta.writeString(3, apiKey);
  meta.writeString(4, "en");
  meta.writeString(7, WS_LS_VER);
  meta.writeString(12, WS_APP);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));

  const outer = new ProtobufEncoder();
  outer.writeMessage(1, meta);

  const resp = await _unaryRequest(`${AUTH_BASE}/GetUserJwt`, outer.toBuffer(), false);
  for (const s of extractStrings(resp)) {
    if (s.startsWith("eyJ") && s.includes(".")) {
      return s;
    }
  }
  throw new Error("Failed to extract JWT from GetUserJwt response");
}

/**
 * Check rate limit. Returns true if OK, false if rate-limited.
 * @param {string} apiKey
 * @param {string} jwt
 * @returns {Promise<boolean>}
 */
export async function checkRateLimit(apiKey, jwt) {
  const req = new ProtobufEncoder();
  req.writeMessage(1, _buildMetadata(apiKey, jwt));
  req.writeString(3, WS_MODEL);

  try {
    await _unaryRequest(`${API_BASE}/CheckUserMessageRateLimit`, req.toBuffer(), true);
    return true;
  } catch (e) {
    if (e.status === 429) return false;
    return true; // Don't block on network issues
  }
}

// ─── Request Building ──────────────────────────────────────

/**
 * Build protobuf metadata with app info, system info, JWT, etc.
 * @param {string} apiKey
 * @param {string} jwt
 * @returns {ProtobufEncoder}
 */
function _buildMetadata(apiKey, jwt) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, WS_APP);
  meta.writeString(2, WS_APP_VER);
  meta.writeString(3, apiKey);
  meta.writeString(4, "en");

  const plat = platform();
  const sysInfo = {
    Os: plat,
    Arch: arch(),
    Release: release(),
    Version: osVersion(),
    Machine: arch(),
    Nodename: hostname(),
    Sysname: plat === "darwin" ? "Darwin" : plat === "win32" ? "Windows_NT" : "Linux",
    ProductVersion: "",
  };
  meta.writeString(5, JSON.stringify(sysInfo));
  meta.writeString(7, WS_LS_VER);

  const cpuList = cpus();
  const ncpu = cpuList.length || 4;
  const mem = totalmem();
  const cpuInfo = {
    NumSockets: 1,
    NumCores: ncpu,
    NumThreads: ncpu,
    VendorID: "",
    Family: "0",
    Model: "0",
    ModelName: cpuList[0]?.model || "Unknown",
    Memory: mem,
  };
  meta.writeString(8, JSON.stringify(cpuInfo));
  meta.writeString(12, WS_APP);
  meta.writeString(21, jwt);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));
  return meta;
}

/**
 * Build a chat message protobuf.
 * @param {number} role - 1=user, 2=assistant, 4=tool_result, 5=system
 * @param {string} content
 * @param {Object} [opts]
 * @param {string} [opts.toolCallId]
 * @param {string} [opts.toolName]
 * @param {string} [opts.toolArgsJson]
 * @param {string} [opts.refCallId]
 * @returns {ProtobufEncoder}
 */
function _buildChatMessage(role, content, opts = {}) {
  const msg = new ProtobufEncoder();
  msg.writeVarint(2, role);
  msg.writeString(3, content);

  if (opts.toolCallId && opts.toolName && opts.toolArgsJson) {
    const tc = new ProtobufEncoder();
    tc.writeString(1, opts.toolCallId);
    tc.writeString(2, opts.toolName);
    tc.writeString(3, opts.toolArgsJson);
    msg.writeMessage(6, tc);
  }

  if (opts.refCallId) {
    msg.writeString(7, opts.refCallId);
  }

  return msg;
}

/**
 * Build a full request with metadata, messages, and tool definitions.
 * @param {string} apiKey
 * @param {string} jwt
 * @param {Array} messages
 * @param {string} toolDefs
 * @param {string} [model] - Model ID (e.g. MODEL_SWE_1_6_SLOW, claude-opus-4-6). Defaults to WS_MODEL.
 * @returns {Buffer}
 */
export function _buildRequest(apiKey, jwt, messages, toolDefs, model) {
  const req = new ProtobufEncoder();
  req.writeMessage(1, _buildMetadata(apiKey, jwt));

  for (const m of messages) {
    req.writeMessage(2, _buildChatMessage(m.role, m.content, m.opts));
  }

  // Field 3 = model ID (same field as checkRateLimit)
  req.writeString(3, model || WS_MODEL);

  if (toolDefs) {
    req.writeString(4, toolDefs);
  }

  return req.toBuffer();
}

// ─── Auto-extract from state.vscdb ─────────────────────────────

/**
 * Get the platform-specific path to Windsurf's state.vscdb.
 * @returns {string}
 */
function getDbPath() {
  const plat = platform();
  const home = homedir();

  // Try Devin Desktop first (post-rebrand), then fall back to Windsurf (legacy)
  const appNames = ["Devin", "Windsurf"];

  if (plat === "darwin") {
    for (const app of appNames) {
      const p = join(home, "Library", "Application Support", app, "User", "globalStorage", "state.vscdb");
      if (existsSync(p)) return p;
    }
    // Default path (for error messaging)
    return join(home, "Library", "Application Support", "Devin", "User", "globalStorage", "state.vscdb");
  } else if (plat === "win32") {
    const appdata = process.env.APPDATA || "";
    if (!appdata) throw new Error("Cannot determine APPDATA path");
    for (const app of appNames) {
      const p = join(appdata, app, "User", "globalStorage", "state.vscdb");
      if (existsSync(p)) return p;
    }
    return join(appdata, "Devin", "User", "globalStorage", "state.vscdb");
  } else {
    // Linux
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    for (const app of appNames) {
      const p = join(config, app, "User", "globalStorage", "state.vscdb");
      if (existsSync(p)) return p;
    }
    return join(config, "Devin", "User", "globalStorage", "state.vscdb");
  }
}

/**
 * Extract API Key from Windsurf state.vscdb.
 * @param {string} [dbPath]
 * @returns {Promise<{ api_key?: string, db_path: string, error?: string, hint?: string }>}
 */
export async function extractKey(dbPath) {
  if (!dbPath) {
    dbPath = getDbPath();
  }

  if (!existsSync(dbPath)) {
    return {
      error: `Windsurf database not found: ${dbPath}`,
      hint: "Ensure Windsurf is installed and logged in.",
      db_path: dbPath,
    };
  }

  let db;
  try {
    const SQL = await initSqlJs();
    const buf = readFileSync(dbPath);
    db = new SQL.Database(buf);
  } catch (e) {
    return { error: `Failed to open database: ${e.message}`, db_path: dbPath };
  }

  try {
    const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'");
    if (!stmt.step()) {
      stmt.free();
      return {
        error: "windsurfAuthStatus record not found",
        hint: "Ensure Windsurf is logged in.",
        db_path: dbPath,
      };
    }

    const row = stmt.getAsObject();
    stmt.free();

    let data;
    try {
      data = JSON.parse(row.value);
    } catch {
      return { error: "windsurfAuthStatus data parse failed", db_path: dbPath };
    }

    const apiKey = data.apiKey || "";
    if (!apiKey) {
      return { error: "apiKey field is empty", db_path: dbPath };
    }

    return { api_key: apiKey, db_path: dbPath };
  } catch (e) {
    return { error: `Extraction failed: ${e.message}`, db_path: dbPath };
  } finally {
    db.close();
  }
}
