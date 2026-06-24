/**
 * Contract tests for handleFetchCore (open-sse/handlers/fetch/index.js)
 * Pattern: vi.stubGlobal("fetch")
 * Handler: handleFetchCore({ url, format, maxCharacters, provider, providerConfig, credentials, log })
 * Returns: { success, data?, status?, error? }
 *
 * Note: handleFetchCore returns { success, data } directly (not { success, response }).
 * The outer handler (src/sse/handlers/fetch.js) wraps data in a Response.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";

// Minimal firecrawl providerConfig stub
const FIRECRAWL_CONFIG = {
  timeoutMs: 5000,
  costPerQuery: 0,
};

const FIRECRAWL_CREDENTIALS = { apiKey: "fc-test-key" };

describe("handleFetchCore — contract", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("missing url → 400", async () => {
    const result = await handleFetchCore({
      url: "",
      provider: "firecrawl",
      providerConfig: FIRECRAWL_CONFIG,
      credentials: FIRECRAWL_CREDENTIALS,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/url/i);
  });

  it("missing provider → 400", async () => {
    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "",
      providerConfig: FIRECRAWL_CONFIG,
      credentials: FIRECRAWL_CREDENTIALS,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/provider/i);
  });

  it("unsupported provider → 400", async () => {
    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "unknown-fetch-provider",
      providerConfig: FIRECRAWL_CONFIG,
      credentials: FIRECRAWL_CREDENTIALS,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/unsupported/i);
  });

  // ── Happy path — firecrawl ──────────────────────────────────────────────────

  it("happy firecrawl fetch → success + data shape", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            markdown: "# Hello\n\nThis is the page content.",
            metadata: { title: "Hello Page" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleFetchCore({
      url: "https://example.com",
      format: "markdown",
      provider: "firecrawl",
      providerConfig: FIRECRAWL_CONFIG,
      credentials: FIRECRAWL_CREDENTIALS,
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data).toHaveProperty("provider", "firecrawl");
    expect(result.data).toHaveProperty("url", "https://example.com");
    expect(result.data).toHaveProperty("content");
    expect(result.data.content).toHaveProperty("text");
    expect(result.data.content.text).toContain("Hello");
  });

  it("happy firecrawl — title extracted from metadata", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            markdown: "Content here",
            metadata: { title: "My Page Title" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "firecrawl",
      providerConfig: FIRECRAWL_CONFIG,
      credentials: FIRECRAWL_CREDENTIALS,
    });

    expect(result.success).toBe(true);
    expect(result.data.title).toBe("My Page Title");
  });

  it("happy jina-reader fetch → success + data shape", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("# Page Title\n\nSome content here.", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await handleFetchCore({
      url: "https://example.com",
      format: "markdown",
      provider: "jina-reader",
      providerConfig: { timeoutMs: 5000 },
      credentials: { apiKey: "jina-test" },
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("provider", "jina-reader");
    expect(result.data.content.text).toContain("Some content");
  });

  // ── maxCharacters truncation ────────────────────────────────────────────────

  it("maxCharacters truncates content", async () => {
    const longText = "A".repeat(10000);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { markdown: longText, metadata: {} },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "firecrawl",
      providerConfig: FIRECRAWL_CONFIG,
      credentials: FIRECRAWL_CREDENTIALS,
      maxCharacters: 100,
    });

    expect(result.success).toBe(true);
    expect(result.data.content.text.length).toBeLessThanOrEqual(100);
  });

  // ── Provider error ──────────────────────────────────────────────────────────

  it("provider 429 → success false, status 429", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "firecrawl",
      providerConfig: FIRECRAWL_CONFIG,
      credentials: FIRECRAWL_CREDENTIALS,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
  });

  // ── Network error → 502 ─────────────────────────────────────────────────────

  it("network error → 502", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "firecrawl",
      providerConfig: FIRECRAWL_CONFIG,
      credentials: FIRECRAWL_CREDENTIALS,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });
});
