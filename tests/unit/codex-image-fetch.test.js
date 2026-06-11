/**
 * Codex executor: verify remote image URLs are fetched and inlined as
 * base64 data URIs BEFORE the request body reaches the upstream API.
 *
 * Covers bug #575:
 *  - prefetchImages must await async image fetches
 *  - execute() must run prefetchImages before super.execute so the body
 *    sent to upstream contains base64 data, not remote URLs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const IMAGE_1MB_BYTES = 1024 * 1024;
const REMOTE_URL = "https://example.com/big.jpg";
const DATA_URI = "data:image/png;base64,iVBORw0KGgo=";

function makeImageBuffer(sizeBytes) {
  const buf = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) buf[i] = i & 0xff;
  return buf.buffer;
}

function mockImageFetch(sizeBytes, mimeType = "image/jpeg") {
  return {
    ok: true,
    headers: { get: (k) => (k === "Content-Type" ? mimeType : null) },
    arrayBuffer: async () => makeImageBuffer(sizeBytes),
  };
}

describe("CodexExecutor image handling", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches 1MB remote image and inlines it as base64 data URI", async () => {
    global.fetch = vi.fn(async () => mockImageFetch(IMAGE_1MB_BYTES));

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this" },
            { type: "image_url", image_url: { url: REMOTE_URL, detail: "high" } },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    const imgBlock = body.input[0].content.find((c) => c.type === "input_image");
    expect(imgBlock, "input_image block must be present after prefetch").toBeDefined();
    expect(imgBlock.image_url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(imgBlock.detail).toBe("high");

    const base64Payload = imgBlock.image_url.split(",")[1];
    const decodedLen = Buffer.from(base64Payload, "base64").length;
    expect(decodedLen).toBe(IMAGE_1MB_BYTES);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes through existing data URIs without calling fetch", async () => {
    global.fetch = vi.fn();

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: DATA_URI } }],
        },
      ],
    };

    await executor.prefetchImages(body);

    const imgBlock = body.input[0].content.find((c) => c.type === "input_image");
    expect(imgBlock.image_url).toBe(DATA_URI);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("falls back to original URL when remote fetch fails", async () => {
    global.fetch = vi.fn(async () => { throw new Error("network down"); });

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: REMOTE_URL } }],
        },
      ],
    };

    await executor.prefetchImages(body);

    const imgBlock = body.input[0].content.find((c) => c.type === "input_image");
    expect(imgBlock.image_url).toBe(REMOTE_URL);
  });

  it("execute() prefetches images before sending to upstream", async () => {
    global.fetch = vi.fn(async () => mockImageFetch(IMAGE_1MB_BYTES));

    let capturedBodyString = null;
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (url, init) => {
      capturedBodyString = init.body;
      return { ok: true, status: 200, headers: new Map() };
    });

    const executor = new CodexExecutor();
    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: REMOTE_URL } }],
        },
      ],
    };

    await executor.execute({
      model: "gpt-5.3-codex",
      body,
      stream: true,
      credentials: { accessToken: "test" },
    });

    expect(capturedBodyString).toBeTypeOf("string");
    expect(capturedBodyString).not.toBe("{}");
    const parsed = JSON.parse(capturedBodyString);
    const imgBlock = parsed.input[0].content.find((c) => c.type === "input_image");
    expect(imgBlock.image_url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("detects context-window errors hidden inside 200 OK SSE", async () => {
    const executor = new CodexExecutor();
    const sse = `event: response.failed\ndata: {"response":{"error":{"message":"Your input exceeds the context window of this model."}}}\n\n`;

    const peek = await executor._peekSseOverloaded(new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    expect(peek.matchType).toBe("context");
    expect(peek.matched).toBe("exceeds the context window");
    await expect(new Response(peek.replacementBody).text()).resolves.toContain("context window");
  });

  it("detects delayed context-window SSE failures beyond the old 4KB peek", async () => {
    const executor = new CodexExecutor();
    const padding = "x".repeat(8 * 1024);
    const sse = `event: response.created\ndata: {"type":"response.created","response":{"id":"r1","metadata":{"padding":"${padding}"}}}\n\n` +
      `event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"Your input exceeds the context window of this model."}}}\n\n`;

    const peek = await executor._peekSseOverloaded(new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    expect(peek.matchType).toBe("context");
    expect(peek.matched).toBe("exceeds the context window");
  });

  it("does not classify normal output text mentioning context windows as an SSE context failure", async () => {
    const executor = new CodexExecutor();
    const sse = `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"The phrase exceeds the context window appears in normal text."}\n\n`;

    const peek = await executor._peekSseOverloaded(new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    expect(peek.matchType).toBeNull();
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toContain("normal text");
  });

  it("execute() converts hidden context-window SSE failures to HTTP 400 JSON", async () => {
    const sse = `event: response.failed\ndata: {"response":{"error":{"message":"Your input exceeds the context window of this model."}}}\n\n`;
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue(new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const executor = new CodexExecutor();
    const result = await executor.execute({
      model: "gpt-5.5-xhigh",
      body: { input: [{ role: "user", content: "huge request" }] },
      stream: true,
      credentials: { accessToken: "test" },
      log: { warn: vi.fn(), debug: vi.fn() },
    });

    expect(proxyFetchModule.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toMatchObject({
      error: {
        code: "context_window_exceeded",
        message: expect.stringContaining("context window"),
      },
    });
  });
});
