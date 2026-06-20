/**
 * Telegram Scraper Relay — Multi-account bot-to-bot message relay (Story 2-38)
 *
 * Đăng nhập nhiều account Telegram (GramJS/MTProto), gửi command tới supplier bot,
 * nhận response, trả về cho 9router adapter.
 *
 * Features:
 * - Multi-account pool: round-robin + fallback khi account lỗi
 * - Session persist: lưu session string để không cần login lại
 * - Rate limit: tối thiểu 5s giữa các request per account
 * - Health tracking: đánh dấu account unhealthy khi flood/ban
 * - HTTP API: POST /relay → { botUsername, command } → { ok, messages }
 *
 * Setup:
 * 1. npm install telegram (GramJS)
 * 2. Set env: TELEGRAM_API_ID, TELEGRAM_API_HASH (từ https://my.telegram.org)
 * 3. Set env: RELAY_ACCOUNTS='[{"phone":"+84xxx","session":"..."},{"phone":"+84yyy","session":""}]'
 * 4. Lần đầu chạy account mới (session rỗng): script yêu cầu nhập code OTP
 * 5. Set env: RELAY_PORT=3800 (default)
 *
 * Usage from 9router adapter:
 * POST http://localhost:3800/relay
 * { "botUsername": "tainguyenvibebot", "command": "/products" }
 * → { "ok": true, "messages": ["...catalog text..."], "account": "+84xxx" }
 */

import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.RELAY_PORT || 3800);
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || "";
const ACCOUNTS_FILE = process.env.RELAY_ACCOUNTS_FILE || "./relay-accounts.json";
const WAIT_RESPONSE_MS = Number(process.env.RELAY_WAIT_MS || 8000);
const MIN_INTERVAL_MS = 5000;

let accounts = [];
let currentIndex = 0;

function loadAccounts() {
  if (process.env.RELAY_ACCOUNTS) {
    accounts = JSON.parse(process.env.RELAY_ACCOUNTS);
  } else if (fs.existsSync(ACCOUNTS_FILE)) {
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  }
  for (const acc of accounts) {
    acc.healthy = acc.healthy !== false;
    acc.lastUsed = acc.lastUsed || 0;
    acc.client = null;
  }
}

function getNextHealthyAccount() {
  const now = Date.now();
  const healthy = accounts.filter((a) => a.healthy && (now - a.lastUsed) >= MIN_INTERVAL_MS);
  if (!healthy.length) {
    const anyHealthy = accounts.filter((a) => a.healthy);
    if (!anyHealthy.length) return null;
    return anyHealthy[0];
  }
  currentIndex = (currentIndex + 1) % healthy.length;
  return healthy[currentIndex];
}

function markUnhealthy(acc, reason) {
  acc.healthy = false;
  acc.unhealthyReason = reason;
  acc.unhealthySince = new Date().toISOString();
  console.error(`[relay] Account ${acc.phone} marked unhealthy: ${reason}`);
  setTimeout(() => {
    acc.healthy = true;
    console.log(`[relay] Account ${acc.phone} re-enabled after cooldown`);
  }, 30 * 60 * 1000);
}

async function initClient(acc) {
  if (acc.client) return acc.client;

  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");

  const session = new StringSession(acc.session || "");
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
  });

  if (!acc.session) {
    // Interactive login — chỉ cần lần đầu
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((r) => rl.question(q, r));

    await client.start({
      phoneNumber: () => Promise.resolve(acc.phone),
      password: () => ask(`[${acc.phone}] 2FA password: `),
      phoneCode: () => ask(`[${acc.phone}] OTP code: `),
      onError: (e) => console.error("[relay] login error:", e.message),
    });
    rl.close();

    acc.session = client.session.save();
    saveAccounts();
    console.log(`[relay] ${acc.phone} logged in, session saved.`);
  } else {
    await client.connect();
  }

  acc.client = client;
  return client;
}

function saveAccounts() {
  const data = accounts.map(({ phone, session, healthy }) => ({ phone, session, healthy }));
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}

async function sendAndReceive(acc, botUsername, command) {
  const client = await initClient(acc);
  acc.lastUsed = Date.now();

  const entity = await client.getEntity(botUsername);
  await client.sendMessage(entity, { message: command });

  await new Promise((r) => setTimeout(r, WAIT_RESPONSE_MS));

  const messages = await client.getMessages(entity, { limit: 5 });
  const botMessages = messages
    .filter((m) => m.fromId?.userId?.toString() !== acc.userId && m.message)
    .map((m) => m.message);

  return botMessages;
}

async function handleRelay(req, res) {
  if (req.method !== "POST" || req.url !== "/relay") {
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
    return;
  }

  const { botUsername, command } = parsed;
  if (!botUsername || !command) {
    res.writeHead(400);
    res.end(JSON.stringify({ ok: false, error: "botUsername and command required" }));
    return;
  }

  // Try accounts with fallback
  const tried = new Set();
  while (tried.size < accounts.length) {
    const acc = getNextHealthyAccount();
    if (!acc || tried.has(acc.phone)) {
      res.writeHead(503);
      res.end(JSON.stringify({ ok: false, error: "All accounts unavailable" }));
      return;
    }
    tried.add(acc.phone);

    try {
      const messages = await sendAndReceive(acc, botUsername, command);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, messages, account: acc.phone }));
      return;
    } catch (e) {
      const msg = e.message || "";
      if (msg.includes("FLOOD") || msg.includes("banned") || msg.includes("AUTH_KEY")) {
        markUnhealthy(acc, msg);
      } else {
        console.error(`[relay] ${acc.phone} error: ${msg}, trying next...`);
      }
    }
  }

  res.writeHead(503);
  res.end(JSON.stringify({ ok: false, error: "All accounts failed" }));
}

// ─── Health endpoint ──────────────────────────────────────────────────────────

function handleHealth(req, res) {
  if (req.url !== "/health") return false;
  const status = accounts.map(({ phone, healthy, unhealthyReason, lastUsed }) => ({
    phone, healthy, unhealthyReason, lastUsed: lastUsed ? new Date(lastUsed).toISOString() : null,
  }));
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, accounts: status }));
  return true;
}

// ─── Start server ─────────────────────────────────────────────────────────────

loadAccounts();
console.log(`[relay] Loaded ${accounts.length} account(s)`);

if (!API_ID || !API_HASH) {
  console.error("[relay] TELEGRAM_API_ID and TELEGRAM_API_HASH are required. Get them from https://my.telegram.org");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (handleHealth(req, res)) return;
  handleRelay(req, res);
});

server.listen(PORT, () => {
  console.log(`[relay] Telegram Scraper Relay running on port ${PORT}`);
  console.log(`[relay] POST /relay → { botUsername, command }`);
  console.log(`[relay] GET /health → account status`);
});
