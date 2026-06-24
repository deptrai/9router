/**
 * Contract tests for handleSttCore (open-sse/handlers/sttCore.js)
 * Pattern: vi.stubGlobal("fetch") — same as embeddingsCore.test.js
 * Handler: handleSttCore({ provider, model, formData, credentials })
 * Returns: { success, response?, status?, error? }
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";

describe("handleSttCore — contract", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("missing file → 400", async () => {
    const formData = new FormData();
    formData.append("model", "whisper-1");

    const result = await handleSttCore({
      provider: "openai",
      model: "whisper-1",
      formData,
      credentials: { apiKey: "sk-test" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/file/i);
  });

  it("missing model → still proceeds (model comes from outer handler)", async () => {
    const formData = new FormData();
    formData.append("file", new File(["audio"], "test.mp3", { type: "audio/mpeg" }));

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "Hello world" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleSttCore({
      provider: "openai",
      model: "whisper-1",
      formData,
      credentials: { apiKey: "sk-test" },
    });

    expect(result.success).toBe(true);
  });

  // ── Happy path — OpenAI transcription ───────────────────────────────────────

  it("happy openai transcription → {text} envelope", async () => {
    const formData = new FormData();
    formData.append("file", new File(["audio"], "test.mp3", { type: "audio/mpeg" }));
    formData.append("model", "whisper-1");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "Hello world" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleSttCore({
      provider: "openai",
      model: "whisper-1",
      formData,
      credentials: { apiKey: "sk-test" },
    });

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body).toHaveProperty("text");
    expect(body.text).toBe("Hello world");
  });

  it("forwards language and prompt from formData", async () => {
    const formData = new FormData();
    formData.append("file", new File(["audio"], "test.mp3", { type: "audio/mpeg" }));
    formData.append("model", "whisper-1");
    formData.append("language", "en");
    formData.append("prompt", "This is a test");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "Hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await handleSttCore({
      provider: "openai",
      model: "whisper-1",
      formData,
      credentials: { apiKey: "sk-test" },
    });

    expect(fetch).toHaveBeenCalled();
    const [, init] = vi.mocked(fetch).mock.calls[0];
    // FormData body — check that our params were appended
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("language")).toBe("en");
    expect(init.body.get("prompt")).toBe("This is a test");
  });

  // ── Provider error → propagates ──────────────────────────────────────────────

  it("provider 429 → result.success false, status 429", async () => {
    const formData = new FormData();
    formData.append("file", new File(["audio"], "test.mp3", { type: "audio/mpeg" }));

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleSttCore({
      provider: "openai",
      model: "whisper-1",
      formData,
      credentials: { apiKey: "sk-test" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
  });

  // ── Network error → 502 ─────────────────────────────────────────────────────

  it("network error → 502", async () => {
    const formData = new FormData();
    formData.append("file", new File(["audio"], "test.mp3", { type: "audio/mpeg" }));

    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await handleSttCore({
      provider: "openai",
      model: "whisper-1",
      formData,
      credentials: { apiKey: "sk-test" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });
});
