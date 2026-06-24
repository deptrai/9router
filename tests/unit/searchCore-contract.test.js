/**
 * Contract tests for handleSearchCore (open-sse/handlers/search/index.js)
 * Pattern: vi.stubGlobal("fetch") — mirrors embeddingsCore.test.js
 * Handler: handleSearchCore({ body, provider, providerConfig, credentials, log })
 * Returns: { success, response, status?, error? }
 *
 * handleSearchCore receives an already-resolved provider object from the outer
 * handler. We pass a minimal stub that satisfies the dispatch logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// chatSearch.js calls handleChatCore which pulls in executors — mock it out
vi.mock("../../open-sse/handlers/search/chatSearch.js", () => ({
  handleChatSearch: vi.fn().mockResolvedValue({ success: false, status: 503, error: "chat fallback not used" }),
}));

import { handleSearchCore } from "../../open-sse/handlers/search/index.js";

// Minimal provider stub that matches AI_PROVIDERS shape needed by handleSearchCore
const STUB_PROVIDER = {
  id: "brave-search",
  searchConfig: {
    authType: "bearer",
    baseUrl: "https://api.search.brave.com/res/v1/web/search",
    format: "brave-search",
    timeoutMs: 5000,
    defaultMaxResults: 5,
    maxMaxResults: 20,
    costPerQuery: 0,
  },
};

const STUB_CREDENTIALS = { apiKey: "brave-test-key" };

// Minimal valid search body
function makeBody(overrides = {}) {
  return { query: "test query", provider: "brave", ...overrides };
}

// Minimal Brave search response
function makeBraveResponse(results = []) {
  return {
    web: {
      results: results.length
        ? results
        : [{ title: "Example", url: "https://example.com", description: "A result" }],
    },
  };
}

describe("handleSearchCore — contract", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("missing query → 400", async () => {
    const result = await handleSearchCore({
      body: { query: "" },
      provider: STUB_PROVIDER,
      providerConfig: STUB_PROVIDER.searchConfig,
      credentials: STUB_CREDENTIALS,
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });

  it("whitespace query → 400", async () => {
    const result = await handleSearchCore({
      body: { query: "   " },
      provider: STUB_PROVIDER,
      providerConfig: STUB_PROVIDER.searchConfig,
      credentials: STUB_CREDENTIALS,
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });

  it("provider without searchConfig and no searchViaChat → 400", async () => {
    const result = await handleSearchCore({
      body: makeBody(),
      provider: { id: "noop" },
      providerConfig: null,
      credentials: null,
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("happy search → success + response shape {provider, query, results}", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(makeBraveResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleSearchCore({
      body: makeBody(),
      provider: STUB_PROVIDER,
      providerConfig: STUB_PROVIDER.searchConfig,
      credentials: STUB_CREDENTIALS,
      log: null,
    });

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body).toHaveProperty("provider");
    expect(body).toHaveProperty("query");
    expect(body).toHaveProperty("results");
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("happy search — results array is populated", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          makeBraveResponse([
            { title: "Result 1", url: "https://r1.com", description: "desc1" },
            { title: "Result 2", url: "https://r2.com", description: "desc2" },
          ])
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleSearchCore({
      body: makeBody(),
      provider: STUB_PROVIDER,
      providerConfig: STUB_PROVIDER.searchConfig,
      credentials: STUB_CREDENTIALS,
      log: null,
    });

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.results.length).toBeGreaterThan(0);
  });

  // ── Provider error → propagates ─────────────────────────────────────────────

  it("provider 429 → success false, status 429", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleSearchCore({
      body: makeBody(),
      provider: STUB_PROVIDER,
      providerConfig: STUB_PROVIDER.searchConfig,
      credentials: STUB_CREDENTIALS,
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
  });

  // ── Network error → 502 ─────────────────────────────────────────────────────

  it("network error → 502", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await handleSearchCore({
      body: makeBody(),
      provider: STUB_PROVIDER,
      providerConfig: STUB_PROVIDER.searchConfig,
      credentials: STUB_CREDENTIALS,
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });
});
