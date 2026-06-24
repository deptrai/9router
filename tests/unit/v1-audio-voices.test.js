/**
 * Contract tests for GET /v1/audio/voices (src/app/api/v1/audio/voices/route.js)
 * Tests the route handler directly by importing GET and calling with a Request.
 *
 * Route shape:
 *   GET /v1/audio/voices?provider={p}[&lang=xx]
 *   - missing/unknown provider → 400 { error: { message: "provider must be one of: ..." } }
 *   - valid provider → fetch internal API → { object: "list", data: [{id,name,lang,gender,model}] }
 *
 * Mocks:
 *   - next/server → stub NextResponse to use native Response.json
 *   - global.fetch → vi.fn() to intercept internal API calls
 *   - @/shared/constants/providers → minimal stub so AI_PROVIDERS[provider]?.alias works
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub next/server before importing the route
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => Response.json(body, init),
  },
}));

// Minimal stub for AI_PROVIDERS — only the providers actually used by the voices route
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    elevenlabs: { alias: "el" },
    deepgram: { alias: "dg" },
    inworld: { alias: "inworld" },
    "edge-tts": { alias: "edge-tts" },
    "local-device": { alias: "local-device" },
  },
}));

const originalFetch = global.fetch;

// Import GET after mocks are set up
const { GET } = await import("../../src/app/api/v1/audio/voices/route.js");

const BASE_URL = "http://localhost:3000";

function makeRequest(params = {}) {
  const url = new URL(`${BASE_URL}/v1/audio/voices`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString());
}

describe("GET /v1/audio/voices — contract", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("missing provider → 400 with list of valid providers", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/provider must be one of/i);
    // Should enumerate at least the known providers
    expect(body.error.message).toContain("elevenlabs");
  });

  it("unknown provider → 400", async () => {
    const res = await GET(makeRequest({ provider: "totally-unknown-xyz" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // ── Happy path — elevenlabs ─────────────────────────────────────────────────

  it("valid provider elevenlabs → {object:'list', data:[...]} shape", async () => {
    // Internal API returns { byLang: { en: { voices: [...] } } }
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          byLang: {
            en: {
              voices: [
                { id: "rachel", name: "Rachel", lang: "en", gender: "female" },
                { id: "adam", name: "Adam", lang: "en", gender: "male" },
              ],
            },
          },
          languages: ["en"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const res = await GET(makeRequest({ provider: "elevenlabs" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
    // Each voice must have id, name, lang, gender, model
    const v = body.data[0];
    expect(v).toHaveProperty("id");
    expect(v).toHaveProperty("name");
    expect(v).toHaveProperty("lang");
    expect(v).toHaveProperty("gender");
    expect(v).toHaveProperty("model");
    // model should be alias/id (el/rachel)
    expect(v.model).toBe("el/rachel");
  });

  it("valid provider with lang filter → uses voices array from response", async () => {
    // When ?lang=en, internal API returns { voices: [...] } (not byLang)
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          voices: [
            { id: "edge-en-us", name: "EN US", lang: "en", gender: "female" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const res = await GET(makeRequest({ provider: "edge-tts", lang: "en" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBe(1);
    expect(body.data[0].model).toBe("edge-tts/edge-en-us");
  });

  it("model field uses provider alias — deepgram alias 'dg'", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          byLang: {
            en: {
              voices: [{ id: "aura-asteria-en", name: "Asteria", lang: "en", gender: "female" }],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const res = await GET(makeRequest({ provider: "deepgram" }));
    const body = await res.json();
    expect(body.data[0].model).toBe("dg/aura-asteria-en");
  });

  // ── Upstream error propagation ──────────────────────────────────────────────

  it("upstream API returns error → forwards error response", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "API key invalid" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    );

    const res = await GET(makeRequest({ provider: "elevenlabs" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // ── Network error → 502 ─────────────────────────────────────────────────────

  it("network error → 502", async () => {
    global.fetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await GET(makeRequest({ provider: "elevenlabs" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
