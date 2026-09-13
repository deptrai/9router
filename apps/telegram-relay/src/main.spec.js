import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createRelayServer,
  extractToken,
  tokenMatches,
  validateStartupEnv,
} from "./main.js";

const TEST_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeRequest(server, { method = "GET", path = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = addr.port;
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json,
          raw,
        });
      });
    });

    req.on("error", reject);
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

describe("telegram relay main — security & token verification", () => {
  it("matches tokens constant-time via SHA-256 timingSafeEqual", () => {
    assert.strictEqual(tokenMatches("secret123", "secret123"), true);
    assert.strictEqual(tokenMatches("secret123", "wrongsecret"), false);
    assert.strictEqual(tokenMatches("secret123", "secret12"), false);
    assert.strictEqual(tokenMatches("", "secret123"), false);
    assert.strictEqual(tokenMatches("secret123", ""), false);
    assert.strictEqual(tokenMatches(null, "secret123"), false);
    assert.strictEqual(tokenMatches("secret123", undefined), false);
  });

  it("extracts Bearer token and alternate x-relay-token", () => {
    assert.strictEqual(
      extractToken({ headers: { authorization: "Bearer my-secret-token" } }),
      "my-secret-token",
    );
    assert.strictEqual(
      extractToken({ headers: { "x-relay-token": "alt-token" } }),
      "alt-token",
    );
    assert.strictEqual(extractToken({ headers: {} }), "");
    assert.strictEqual(extractToken({}), "");
  });

  it("validates startup environment variables strictly", () => {
    const valid = {
      apiId: 12345,
      apiHash: "abcdef1234567890",
      session: "1BJWap1wBu...",
      authToken: TEST_TOKEN,
    };
    assert.deepStrictEqual(validateStartupEnv(valid), []);

    // Missing API ID
    const noApiId = validateStartupEnv({ ...valid, apiId: 0 });
    assert.strictEqual(noApiId.some((e) => e.includes("TELEGRAM_API_ID")), true);

    // Negative API ID
    const negApiId = validateStartupEnv({ ...valid, apiId: -5 });
    assert.strictEqual(negApiId.some((e) => e.includes("TELEGRAM_API_ID")), true);

    // Missing API Hash
    const noApiHash = validateStartupEnv({ ...valid, apiHash: "" });
    assert.strictEqual(noApiHash.some((e) => e.includes("TELEGRAM_API_HASH")), true);

    // Missing Session
    const noSession = validateStartupEnv({ ...valid, session: "   " });
    assert.strictEqual(noSession.some((e) => e.includes("TELEGRAM_SESSION")), true);

    // Short auth token (< 32 hex chars)
    const shortToken = validateStartupEnv({ ...valid, authToken: "1234567890abcdef" });
    assert.strictEqual(shortToken.some((e) => e.includes("RELAY_AUTH_TOKEN")), true);

    // Non-hex auth token
    const nonHexToken = validateStartupEnv({ ...valid, authToken: "this_is_not_a_hex_token_32_characters_long" });
    assert.strictEqual(nonHexToken.some((e) => e.includes("RELAY_AUTH_TOKEN")), true);
  });
});

describe("telegram relay main — HTTP server endpoints", () => {
  let server;
  let mockClient;

  before(async () => {
    mockClient = {
      getEntity: async (username) => {
        if (username === "real_human") {
          return { className: "User", bot: false, id: 999 };
        }
        if (username === "some_channel") {
          return { className: "Channel", bot: false, id: 888 };
        }
        if (username === "flood_bot") {
          throw new Error("A wait of 30 seconds is required (caused by SendMessageRequest: FLOOD_WAIT_30)");
        }
        if (username === "banned_bot") {
          throw new Error("The user has been deleted/deactivated (caused by SendMessageRequest: USER_DEACTIVATED_BAN)");
        }
        return { className: "User", bot: true, id: 12345 };
      },
      getMessages: async () => [
        { id: 10, out: false, message: "old message" },
      ],
      sendMessage: async () => {
        return { id: 11, out: true };
      },
    };

    server = createRelayServer({
      authToken: TEST_TOKEN,
      client: mockClient,
      pollIntervalMs: 10,
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      await server._closeClient();
    }
  });

  it("GET /liveness returns 200 without authentication", async () => {
    const res = await makeRequest(server, { method: "GET", path: "/liveness" });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true, status: "ok" });
  });

  it("GET /health requires authentication", async () => {
    // Unauthenticated
    const unauth = await makeRequest(server, { method: "GET", path: "/health" });
    assert.strictEqual(unauth.statusCode, 401);
    assert.strictEqual(unauth.body.ok, false);

    // Wrong token
    const wrong = await makeRequest(server, {
      method: "GET",
      path: "/health",
      headers: { Authorization: "Bearer wrongtoken" },
    });
    assert.strictEqual(wrong.statusCode, 401);

    // Valid token
    const valid = await makeRequest(server, {
      method: "GET",
      path: "/health",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.strictEqual(valid.statusCode, 200);
    assert.strictEqual(valid.body.ok, true);
    assert.strictEqual(valid.body.status, "healthy");
    assert.strictEqual(valid.body.busy, false);
  });

  it("GET /health reflects cooldown status with 503", async () => {
    server._setState({ cooldownUntil: Date.now() + 10_000, lastError: "FLOOD_WAIT_10" });

    const res = await makeRequest(server, {
      method: "GET",
      path: "/health",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.status, "cooldown");
    assert.strictEqual(res.body.error, "FLOOD_WAIT_10");
    assert.ok(res.body.cooldownMs > 0);

    // Reset cooldown
    server._setState({ cooldownUntil: 0, lastError: null });
  });

  it("GET /health reflects permanently_unhealthy status with 503", async () => {
    server._setState({ isPermanentlyUnhealthy: true, lastError: "SESSION_BANNED" });

    const res = await makeRequest(server, {
      method: "GET",
      path: "/health",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.status, "permanently_unhealthy");

    // Reset unhealthy
    server._setState({ isPermanentlyUnhealthy: false, lastError: null });
  });

  it("POST /relay requires authentication", async () => {
    const unauth = await makeRequest(server, {
      method: "POST",
      path: "/relay",
      body: { botUsername: "valid_bot", command: "/products" },
    });
    assert.strictEqual(unauth.statusCode, 401);
  });

  it("POST /relay rejects concurrent in-flight requests with 503 RELAY_BUSY", async () => {
    server._setState({ isBusy: true });

    const res = await makeRequest(server, {
      method: "POST",
      path: "/relay",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: { botUsername: "valid_bot", command: "/products" },
    });

    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.body, { ok: false, error: "RELAY_BUSY" });

    server._setState({ isBusy: false });
  });

  it("POST /relay verifies target entity and rejects non-bot targets (Security: S1)", async () => {
    // Non-bot user
    const userRes = await makeRequest(server, {
      method: "POST",
      path: "/relay",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: { botUsername: "real_human", command: "/products" },
    });
    assert.strictEqual(userRes.statusCode, 400);
    assert.match(userRes.body.error, /Target entity must be a Telegram bot/i);

    // Channel target
    const channelRes = await makeRequest(server, {
      method: "POST",
      path: "/relay",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: { botUsername: "some_channel", command: "/products" },
    });
    assert.strictEqual(channelRes.statusCode, 400);
    assert.match(channelRes.body.error, /Target entity must be a Telegram bot/i);
  });

  it("POST /relay handles FLOOD_WAIT_N and sets cooldown", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      path: "/relay",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: { botUsername: "flood_bot", command: "/products" },
    });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error, "FLOOD_WAIT_30");

    const state = server._getState();
    assert.ok(state.cooldownUntil > Date.now());
    assert.strictEqual(state.lastError, "FLOOD_WAIT_30");

    // Clean up
    server._setState({ cooldownUntil: 0, lastError: null });
  });

  it("POST /relay marks permanently_unhealthy on terminal ban errors", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      path: "/relay",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: { botUsername: "banned_bot", command: "/products" },
    });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error, "SESSION_BANNED");

    const state = server._getState();
    assert.strictEqual(state.isPermanentlyUnhealthy, true);
    assert.strictEqual(state.lastError, "SESSION_BANNED");

    // Clean up and restore mock client
    server._setState({ isPermanentlyUnhealthy: false, lastError: null, client: mockClient });
  });

  it("POST /relay executes valid command flow and returns 200 with messages", async () => {
    // Setup mockClient to simulate Telegram message flow
    const liveMessages = [{ id: 10, out: false, message: "old message" }];
    mockClient.getMessages = async (_entity, { limit }) => {
      return [...liveMessages].sort((a, b) => b.id - a.id).slice(0, limit);
    };
    mockClient.sendMessage = async (_entity, { message }) => {
      liveMessages.push({ id: 11, out: true, message });
      liveMessages.push({ id: 12, out: false, message: "1. 👑 Kiro Promax\n💵 39.000đ" });
      return { id: 11, out: true };
    };

    const res = await makeRequest(server, {
      method: "POST",
      path: "/relay",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: {
        botUsername: "tainguyenvibebot",
        command: "/products",
        collect: { timeoutMs: 1000, idleMs: 50, maxMessages: 5 },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.messages, ["1. 👑 Kiro Promax\n💵 39.000đ"]);
  });

  it("POST /relay serializes buttons when includeButtons is true", async () => {
    const liveMessages = [{ id: 10, out: false, message: "old message" }];
    const categoryMessage = {
      id: 20,
      out: false,
      message: "category menu",
      getButtons: async () => [[
        { text: "⚡ TÀI KHOẢN KIRO", click: async () => {} },
      ]],
    };
    const startMessage = {
      id: 12,
      out: false,
      message: "Main menu",
      getButtons: async () => [[{
        text: "📦 Sản phẩm",
        click: async () => { liveMessages.push(categoryMessage); },
      }]],
    };
    mockClient.getMessages = async (_entity, { limit }) =>
      [...liveMessages].sort((a, b) => b.id - a.id).slice(0, limit);
    mockClient.sendMessage = async (_entity, { message }) => {
      liveMessages.push({ id: 11, out: true, message });
      liveMessages.push(startMessage);
      return { id: 11, out: true };
    };

    const res = await makeRequest(server, {
      method: "POST",
      path: "/relay",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: {
        botUsername: "tainguyenvibebot",
        steps: [
          { action: "send", text: "/start" },
          { action: "press", text: "📦 Sản phẩm", match: "exact", collect: true },
        ],
        collect: { timeoutMs: 1000, idleMs: 50, maxMessages: 5 },
        includeButtons: true,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.ok(Array.isArray(res.body.buttons));
    assert.ok(res.body.buttons.length > 0);
    assert.ok(res.body.buttons.every((b) => typeof b.text === "string"));
  });
});
