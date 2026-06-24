/**
 * Contract tests for handleTtsCore (open-sse/handlers/ttsCore.js)
 * Pattern: global.fetch = vi.fn() — same as minimax-tts.test.js
 * Handler: handleTtsCore({ provider, model, input, credentials, responseFormat })
 * Returns: { success, response?, status?, error? }
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";

const originalFetch = global.fetch;

describe("handleTtsCore — contract", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("missing input → 400", async () => {
    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1",
      input: "",
      credentials: { apiKey: "sk-test" },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/input/i);
  });

  it("whitespace-only input → 400", async () => {
    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1",
      input: "   ",
      credentials: { apiKey: "sk-test" },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });

  // ── Happy path — OpenAI TTS (binary mp3 response) ──────────────────────────

  it("happy path openai TTS — binary mp3 response → success + audio/mpeg", async () => {
    const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]); // fake mp3 header
    global.fetch.mockResolvedValueOnce(
      new Response(audioBytes, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      })
    );

    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1",
      input: "Hello world",
      credentials: { apiKey: "sk-test" },
      responseFormat: "mp3",
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeDefined();
    // Binary format: Content-Type should be audio/*
    const ct = result.response.headers.get("Content-Type");
    expect(ct).toMatch(/^audio\//);
  });

  it("happy path openai TTS — json responseFormat → {audio, format} envelope", async () => {
    const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    global.fetch.mockResolvedValueOnce(
      new Response(audioBytes, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      })
    );

    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1",
      input: "Hello world",
      credentials: { apiKey: "sk-test" },
      responseFormat: "json",
    });

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body).toHaveProperty("audio");
    expect(body).toHaveProperty("format");
  });

  // ── Provider error — OpenAI adapter throws on non-2xx, ttsCore wraps as 502 ─

  it("provider 429 → result.success false (OpenAI adapter throws → 502)", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1",
      input: "Hello",
      credentials: { apiKey: "sk-test" },
    });

    expect(result.success).toBe(false);
    // OpenAI adapter throws on non-2xx; ttsCore catch block returns 502
    expect(result.status).toBe(502);
    expect(result.error).toMatch(/Rate limit exceeded/i);
  });

  // ── Network error → 502 ─────────────────────────────────────────────────────

  it("network error → 502", async () => {
    global.fetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1",
      input: "Hello",
      credentials: { apiKey: "sk-test" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });
});
