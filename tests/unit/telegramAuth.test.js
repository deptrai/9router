import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { verifyTelegramPayload, isTelegramAuthFresh } from "@/lib/auth/telegramAuth.js";

const BOT_TOKEN = "test_bot_token_123";
const FIXED_NOW = 1700000000000; // pinned timestamp for deterministic tests

beforeEach(() => { vi.useFakeTimers({ now: FIXED_NOW }); });
afterEach(() => { vi.useRealTimers(); });

function makePayload(overrides = {}) {
  const data = {
    id: "12345678",
    first_name: "Test",
    auth_date: String(Math.floor(FIXED_NOW / 1000) - 30),
    ...overrides,
  };
  delete data.hash;
  const checkString = Object.keys(data).sort().map(k => `${k}=${data[k]}`).join("\n");
  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");
  return { ...data, hash };
}

describe("verifyTelegramPayload", () => {
  it("valid payload → true", () => {
    expect(verifyTelegramPayload(makePayload(), BOT_TOKEN)).toBe(true);
  });

  it("tampered id without updating hash → false", () => {
    const p = makePayload();
    p.id = "99999999";
    expect(verifyTelegramPayload(p, BOT_TOKEN)).toBe(false);
  });

  it("wrong bot token → false", () => {
    expect(verifyTelegramPayload(makePayload(), "wrong_token")).toBe(false);
  });

  it("missing hash → false", () => {
    const { hash, ...noHash } = makePayload();
    expect(verifyTelegramPayload(noHash, BOT_TOKEN)).toBe(false);
  });

  it("extra fields included in check string are ok", () => {
    const p = makePayload({ username: "testuser", photo_url: "https://t.me/photo.jpg" });
    expect(verifyTelegramPayload(p, BOT_TOKEN)).toBe(true);
  });
});

describe("isTelegramAuthFresh", () => {
  const nowSec = Math.floor(FIXED_NOW / 1000);

  it("auth 30s ago → fresh (true)", () => {
    expect(isTelegramAuthFresh(nowSec - 30)).toBe(true);
  });

  it("auth exactly at maxAge (300s) → true", () => {
    expect(isTelegramAuthFresh(nowSec - 300)).toBe(true);
  });

  it("auth 301s ago → stale (false)", () => {
    expect(isTelegramAuthFresh(nowSec - 301)).toBe(false);
  });

  it("future auth_date → false", () => {
    expect(isTelegramAuthFresh(nowSec + 60)).toBe(false);
  });

  it("custom maxAge honored", () => {
    expect(isTelegramAuthFresh(nowSec - 50, 60)).toBe(true);
    expect(isTelegramAuthFresh(nowSec - 61, 60)).toBe(false);
  });
});
