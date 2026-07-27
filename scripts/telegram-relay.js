/**
 * Telegram Scraper Relay — Multi-account bot-to-bot interaction relay (Story 2-38)
 *
 * Đăng nhập nhiều account Telegram (GramJS/MTProto), chạy flow send/press với
 * supplier bot, nhận response mới và trả về cho 9router adapter.
 *
 * Features:
 * - Multi-account pool: round-robin + fallback khi account lỗi
 * - Session persist: lưu session string để không cần login lại
 * - Rate limit: tối thiểu 5s giữa các request per account
 * - Health tracking: đánh dấu account unhealthy khi flood/ban
 * - Backward-compatible HTTP API: legacy command hoặc bounded interaction steps
 *
 * SECURITY (code review 2026-07-28, D1): the relay holds live MTProto sessions, so an
 * unauthenticated caller that reaches it can send arbitrary text as a real Telegram
 * account. Two independent layers protect it:
 *   1. It binds RELAY_HOST (default 127.0.0.1) — not every interface.
 *   2. Every request to /relay and /health must carry RELAY_AUTH_TOKEN as a bearer
 *      token, compared constant-time (same pattern as the supplier webhook route).
 * Neither layer alone is sufficient: loopback does not help when the relay runs in its
 * own container, and a token does not help if the port is exposed to the internet.
 *
 * Setup:
 * 1. npm install (GramJS is pinned as the `telegram` dependency)
 * 2. Set env: TELEGRAM_API_ID, TELEGRAM_API_HASH (từ https://my.telegram.org)
 * 3. Set env: RELAY_AUTH_TOKEN (bắt buộc — openssl rand -hex 32)
 * 4. Khai báo account trong RELAY_ACCOUNTS_FILE (default ./relay-accounts.json):
 *    [{ "phone": "+84xxx", "session": "" }]
 * 5. Login lần đầu (interactive, cần TTY):  node scripts/telegram-relay.js --login
 *    Lệnh này nhập OTP/2FA rồi ghi session vào RELAY_ACCOUNTS_FILE và thoát.
 * 6. Chạy server:  node scripts/telegram-relay.js
 *    Optional env: RELAY_PORT (3800), RELAY_HOST (127.0.0.1), RELAY_POLL_MS (5000 khi
 *    chạy với bot thật — Telegram FLOOD_WAIT nếu poll GetHistory quá nhanh).
 *
 * Legacy request:
 * { "botUsername": "supplier_bot", "command": "/products" }
 *
 * Interactive request:
 * {
 *   "botUsername": "supplier_bot",
 *   "steps": [
 *     { "action": "send", "text": "/start" },
 *     { "action": "press", "text": "📦 Sản phẩm", "match": "contains" }
 *   ],
 *   "collect": { "timeoutMs": 30000, "idleMs": 1500, "maxMessages": 20 }
 * }
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { runInteraction, validateRelayRequest } from "../src/lib/telegram/relayCore.js";

const PORT = Number(process.env.RELAY_PORT || 3800);
// Loopback by default — binding 0.0.0.0 exposes live Telegram sessions to the network.
// Override only when the relay must be reachable from another host/container, and only
// together with RELAY_AUTH_TOKEN.
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || "";
const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || "";
const ACCOUNTS_FILE = process.env.RELAY_ACCOUNTS_FILE || "./relay-accounts.json";
const POLL_INTERVAL_MS = Number(process.env.RELAY_POLL_MS || 250);
const MIN_INTERVAL_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;
const UNHEALTHY_COOLDOWN_MS = 30 * 60 * 1000;
const LOGIN_MODE = process.argv.includes("--login");

let accounts = [];
let rotationIndex = 0;

/** Mask a phone for logs/responses — the phone is both PII and an account identifier. */
function maskPhone(phone) {
  const value = String(phone ?? "");
  if (value.length <= 4) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

/**
 * Constant-time token compare. Both sides are hashed to a fixed-length SHA-256 digest
 * BEFORE timingSafeEqual so the comparison is always on equal-length buffers, removing
 * the length side-channel. Same helper shape as the supplier webhook route.
 */
function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function extractToken(req) {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  const alt = req.headers["x-relay-token"];
  return typeof alt === "string" ? alt.trim() : "";
}

function loadAccounts() {
  let parsed = null;
  try {
    if (process.env.RELAY_ACCOUNTS) {
      parsed = JSON.parse(process.env.RELAY_ACCOUNTS);
    } else if (fs.existsSync(ACCOUNTS_FILE)) {
      parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    }
  } catch (error) {
    console.error("[relay] Failed to parse accounts config:", error.message);
    accounts = [];
    return;
  }
  // Guard the shape too, not just the JSON syntax — `RELAY_ACCOUNTS='{"phone":"x"}'`
  // parses fine and then throws "is not iterable" outside the try block.
  if (parsed != null && !Array.isArray(parsed)) {
    console.error("[relay] Accounts config must be a JSON array, got:", typeof parsed);
    accounts = [];
    return;
  }
  accounts = (parsed ?? []).filter((account) => account && typeof account === "object");
  for (const account of accounts) {
    // `healthy` is intentionally NOT read back from disk: the 30-minute cooldown lives in
    // an in-process timer, so a persisted `healthy: false` would strand the account
    // forever across a restart. Every account starts healthy and re-earns its status.
    account.healthy = true;
    account.lastUsed = 0;
    account.client = null;
    account.busy = false;
    account.unhealthyTimer = null;
  }
  if (process.env.RELAY_ACCOUNTS && accounts.some((a) => !a.session)) {
    console.warn(
      "[relay] WARNING: accounts came from RELAY_ACCOUNTS env, which takes precedence over "
      + `${ACCOUNTS_FILE}. A session obtained via --login is written to the file but will be `
      + "shadowed by the env var on the next start. Use RELAY_ACCOUNTS_FILE instead so the "
      + "session actually persists.",
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Round-robin over the STABLE accounts array. The previous version modulo'd the pointer
 * against a freshly filtered array whose length changed between calls, so once an account
 * was marked unhealthy mid-request the pointer could land back on an already-tried entry
 * and the caller's fallback loop broke early (503 while healthy accounts remained).
 *
 * Returns `{ account, waitMs }`. `waitMs > 0` means the account is still inside its
 * per-account rate-limit window and the caller must wait it out — we honour
 * MIN_INTERVAL_MS instead of bypassing it, since that window is what keeps Telegram from
 * issuing FLOOD_WAIT / banning the account.
 */
function pickAccount(tried) {
  const now = Date.now();
  const total = accounts.length;
  if (!total) return null;

  let cooling = null;
  for (let offset = 0; offset < total; offset += 1) {
    const index = (rotationIndex + offset) % total;
    const account = accounts[index];
    if (!account.healthy || account.busy || tried.has(account.phone)) continue;
    const elapsed = now - account.lastUsed;
    if (elapsed < MIN_INTERVAL_MS) {
      const waitMs = MIN_INTERVAL_MS - elapsed;
      if (!cooling || waitMs < cooling.waitMs) cooling = { account, waitMs, index };
      continue;
    }
    rotationIndex = (index + 1) % total;
    return { account, waitMs: 0 };
  }

  if (cooling) {
    rotationIndex = (cooling.index + 1) % total;
    return { account: cooling.account, waitMs: cooling.waitMs };
  }
  return null;
}

async function disconnectQuietly(account) {
  const client = account.client;
  account.client = null;
  account._initPromise = null;
  if (!client) return;
  try {
    await client.disconnect();
  } catch {
    /* already gone — nothing to reclaim */
  }
}

function markUnhealthy(account, reason) {
  account.healthy = false;
  account.unhealthyReason = reason;
  account.unhealthySince = new Date().toISOString();
  console.error(`[relay] Account ${maskPhone(account.phone)} marked unhealthy: ${reason}`);

  // Drop the dead client. AUTH_KEY / ban errors leave the connection unusable, and
  // initClient() returns early whenever account.client is truthy — without this reset the
  // account would keep failing forever after its cooldown expired.
  disconnectQuietly(account).catch(() => {});

  // Replace, never stack: a second markUnhealthy used to add a second timer, and the
  // older one would re-enable the account before the newer cooldown had elapsed.
  if (account.unhealthyTimer) clearTimeout(account.unhealthyTimer);
  account.unhealthyTimer = setTimeout(() => {
    account.healthy = true;
    account.unhealthyTimer = null;
    console.log(`[relay] Account ${maskPhone(account.phone)} re-enabled after cooldown`);
  }, UNHEALTHY_COOLDOWN_MS);
  // Do not keep the process alive just to flip a flag back.
  if (account.unhealthyTimer.unref) account.unhealthyTimer.unref();
}

async function createClient(account) {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const session = new StringSession(account.session || "");
  return new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 3 });
}

/**
 * Connect an already-logged-in account. Interactive login is deliberately NOT reachable
 * from here: it used to open readline on process.stdin inside the HTTP request path, so
 * on a container/systemd deployment (no interactive stdin) the promise hung forever and
 * was cached in account._initPromise, wedging every later request too. Login now lives in
 * `--login` CLI mode; the request path fails fast with an actionable message instead.
 */
async function initClient(account) {
  if (account.client) return account.client;
  if (account._initPromise) return account._initPromise;

  if (!account.session) {
    throw new Error(
      `account ${maskPhone(account.phone)} has no session — run "node scripts/telegram-relay.js --login" first`,
    );
  }

  account._initPromise = (async () => {
    const client = await createClient(account);
    await client.connect();
    account.client = client;
    return client;
  })();

  try {
    return await account._initPromise;
  } catch (error) {
    account._initPromise = null;
    throw error;
  }
}

/**
 * Persist sessions atomically with owner-only permissions. A session string is equivalent
 * to full account access, so a torn write (crash mid-writeFileSync) or a world-readable
 * file are both real losses. `relay-accounts.json` is also gitignored.
 */
function saveAccounts() {
  const data = accounts.map(({ phone, session }) => ({ phone, session }));
  const tmp = `${ACCOUNTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNTS_FILE);
  try {
    fs.chmodSync(ACCOUNTS_FILE, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

/** Interactive login for every account missing a session. CLI-only, requires a TTY. */
async function runLoginMode() {
  const pending = accounts.filter((account) => !account.session);
  if (!pending.length) {
    console.log("[relay] All accounts already have a session — nothing to do.");
    return;
  }
  if (!process.stdin.isTTY) {
    console.error("[relay] --login needs an interactive terminal (stdin is not a TTY).");
    process.exit(1);
  }

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

  try {
    for (const account of pending) {
      const client = await createClient(account);
      await client.start({
        phoneNumber: () => Promise.resolve(account.phone),
        password: () => ask(`[${account.phone}] 2FA password: `),
        phoneCode: () => ask(`[${account.phone}] OTP code: `),
        onError: (error) => console.error("[relay] login error:", error.message),
      });
      account.session = client.session.save();
      saveAccounts();
      console.log(`[relay] ${maskPhone(account.phone)} logged in, session saved to ${ACCOUNTS_FILE}`);
      await client.disconnect().catch(() => {});
    }
  } finally {
    rl.close();
  }
}

async function relayInteraction(account, request) {
  const client = await initClient(account);
  const entity = await client.getEntity(request.botUsername);
  return runInteraction(client, entity, request, { pollIntervalMs: POLL_INTERVAL_MS });
}

function sendJson(res, status, payload) {
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

async function readBody(req, res) {
  // Accumulate Buffers, not strings: `body += chunk` decodes each chunk independently, so
  // a multi-byte UTF-8 character split across two TCP segments (routine for payloads like
  // "📦 Sản phẩm") is corrupted into replacement characters.
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      sendJson(res, 413, { ok: false, error: "Request body too large" });
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleRelay(req, res) {
  const body = await readBody(req, res);
  if (body === null) return;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON" });
    return;
  }

  const validation = validateRelayRequest(parsed);
  if (!validation.ok) {
    sendJson(res, 400, { ok: false, error: validation.error });
    return;
  }
  const request = validation.value;

  const tried = new Set();
  let lastError = "All accounts unavailable";
  let result = null;
  let usedAccount = null;

  while (tried.size < accounts.length) {
    const picked = pickAccount(tried);
    if (!picked) break;
    const { account, waitMs } = picked;
    tried.add(account.phone);
    if (waitMs > 0) await sleep(waitMs);

    // Claim the account for the whole interaction. Two concurrent requests used to be
    // able to select the same account (lastUsed was only stamped after the await in
    // initClient), and two interleaved flows in one chat read each other's messages.
    account.busy = true;
    account.lastUsed = Date.now();
    try {
      result = await relayInteraction(account, request);
      usedAccount = account;
      break;
    } catch (error) {
      const message = String(error?.message || "Relay interaction failed").slice(0, 500);
      lastError = message;
      if (message.includes("FLOOD") || message.includes("banned") || message.includes("AUTH_KEY")) {
        markUnhealthy(account, message);
      } else {
        console.error(`[relay] ${maskPhone(account.phone)} error: ${message}, trying next...`);
      }
    } finally {
      account.lastUsed = Date.now();
      account.busy = false;
    }
  }

  // Respond OUTSIDE the try/catch. Previously sendJson sat inside it, so a failure while
  // writing the response (client disconnected, socket error) fell into the catch and the
  // loop replayed the entire send/press flow on another account — a real risk of pressing
  // a buy/confirm button twice for a single request.
  if (result) {
    sendJson(res, 200, {
      ok: true,
      messages: result.messages,
      account: maskPhone(usedAccount?.phone),
    });
    return;
  }
  sendJson(res, 503, { ok: false, error: `All accounts failed: ${lastError}` });
}

function handleHealth(res) {
  const status = accounts.map(({ phone, healthy, unhealthyReason, lastUsed }) => ({
    // Masked: the raw phone leaks into caller logs and could reach admin-visible
    // lastSyncError text.
    phone: maskPhone(phone),
    healthy,
    unhealthyReason,
    lastUsed: lastUsed ? new Date(lastUsed).toISOString() : null,
  }));
  sendJson(res, 200, { ok: true, accounts: status });
}

function route(req, res) {
  // Authenticate BEFORE routing so /health cannot be used as an unauthenticated probe for
  // account count / phone / failure reasons.
  if (!tokenMatches(extractToken(req), AUTH_TOKEN)) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return Promise.resolve();
  }
  if (req.method === "GET" && req.url === "/health") {
    handleHealth(res);
    return Promise.resolve();
  }
  if (req.method === "POST" && req.url === "/relay") {
    return handleRelay(req, res);
  }
  sendJson(res, 404, { ok: false, error: "Not found" });
  return Promise.resolve();
}

function requireEnv() {
  const missing = [];
  if (!API_ID) missing.push("TELEGRAM_API_ID");
  if (!API_HASH) missing.push("TELEGRAM_API_HASH");
  if (!LOGIN_MODE && !AUTH_TOKEN) missing.push("RELAY_AUTH_TOKEN");
  if (!missing.length) return;
  console.error(`[relay] Missing required env: ${missing.join(", ")}`);
  console.error("[relay] TELEGRAM_API_ID / TELEGRAM_API_HASH: https://my.telegram.org");
  console.error("[relay] RELAY_AUTH_TOKEN: openssl rand -hex 32");
  process.exit(1);
}

loadAccounts();
console.log(`[relay] Loaded ${accounts.length} account(s) from ${path.basename(ACCOUNTS_FILE)}`);
requireEnv();

if (LOGIN_MODE) {
  runLoginMode()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[relay] login failed:", error.message);
      process.exit(1);
    });
} else {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    route(req, res).catch((error) => {
      console.error("[relay] Unhandled request error:", error.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Internal relay error" });
      else res.end();
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[relay] Telegram Scraper Relay running on ${HOST}:${PORT}`);
    if (HOST !== "127.0.0.1" && HOST !== "localhost") {
      console.warn(`[relay] WARNING: bound to ${HOST} — relay is reachable beyond loopback. Ensure RELAY_AUTH_TOKEN is strong and the port is firewalled.`);
    }
    console.log("[relay] POST /relay → { botUsername, command } or { botUsername, steps, collect }");
    console.log("[relay] GET /health → account status");
    console.log("[relay] Both endpoints require: Authorization: Bearer $RELAY_AUTH_TOKEN");
  });
}
