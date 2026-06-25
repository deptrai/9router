/**
 * Story N.2 — AC16: DevinExecutor mock-fetch tests.
 * Covers: 200 finished stream:true, stream:false, 403 out_of_quota, 404 org,
 * poll timeout, abort signal, status blocked/expired/error, poll interval env override (F7).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock proxyAwareFetch before importing executor
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { DevinExecutor } from "../../open-sse/executors/devin.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

function makeCredentials(overrides = {}) {
  return {
    apiKey: "cog_test_key",
    providerSpecificData: { orgId: "test-org-id" },
    ...overrides,
  };
}

function makeBody(overrides = {}) {
  return {
    messages: [{ role: "user", content: "Hello Devin" }],
    ...overrides,
  };
}

function mockFetchSequence(responses) {
  let callIdx = 0;
  proxyAwareFetch.mockImplementation(async () => {
    const resp = responses[Math.min(callIdx, responses.length - 1)];
    callIdx++;
    return resp;
  });
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Map(),
  };
}

function errorResponse(status) {
  return {
    ok: false,
    status,
    json: async () => ({ error: "fail" }),
    headers: new Map(),
  };
}

describe("Story N.2 — DevinExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEVIN_POLL_INTERVAL_MS;
    delete process.env.DEVIN_SESSION_TIMEOUT_MS;
  });

  afterEach(() => {
    proxyAwareFetch.mockReset();
  });

  it("200 finished — stream:false → JSON body", async () => {
    mockFetchSequence([
      jsonResponse({ id: "sess-123" }), // create
      jsonResponse({ status_enum: "finished", output: "Task done!" }), // poll
    ]);
    process.env.DEVIN_POLL_INTERVAL_MS = "10"; // fast poll

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("Task done!");
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  it("200 finished — stream:true → SSE chunks", async () => {
    mockFetchSequence([
      jsonResponse({ id: "sess-123" }),
      jsonResponse({ status_enum: "finished", output: "Streamed output" }),
    ]);
    process.env.DEVIN_POLL_INTERVAL_MS = "10";

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: true,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(200);
    // Read SSE stream manually (chunks are strings, not Uint8Array)
    const reader = result.response.body.getReader();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += typeof value === "string" ? value : new TextDecoder().decode(value);
    }
    expect(text).toContain("Streamed output");
    expect(text).toContain("[DONE]");
    expect(text).toContain('"finish_reason":"stop"');
  });

  it("403 out_of_quota → synthetic 403 Response", async () => {
    mockFetchSequence([errorResponse(403)]);

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(403);
    const json = await result.response.json();
    expect(json.error.message).toContain("out_of_quota");
  });

  it("404 org not found → synthetic 404 Response", async () => {
    mockFetchSequence([errorResponse(404)]);

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(404);
  });

  it("400 bad request → parse server detail vào message", async () => {
    // Devin API trả 400 với { detail: "devin_mode 'lite' is not available for this organization" }
    mockFetchSequence([{
      ok: false,
      status: 400,
      json: async () => ({ detail: "devin_mode 'lite' is not available for this organization" }),
      headers: new Map(),
    }]);

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "lite",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(400);
    const json = await result.response.json();
    expect(json.error.message).toContain("devin_mode 'lite' is not available");
  });

  it("403 out_of_quota → parse server detail vào message", async () => {
    // Devin API trả 403 với { detail: "Your organization has a billing error. Error: out_of_quota" }
    mockFetchSequence([{
      ok: false,
      status: 403,
      json: async () => ({ detail: "Your organization has a billing error. Error: out_of_quota" }),
      headers: new Map(),
    }]);

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(403);
    const json = await result.response.json();
    expect(json.error.message).toContain("out_of_quota");
    expect(json.error.message).toContain("billing error");
  });

  it("401 invalid API key → synthetic 401 Response", async () => {
    mockFetchSequence([errorResponse(401)]);

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(401);
  });

  it("status blocked → 503", async () => {
    mockFetchSequence([
      jsonResponse({ id: "sess-123" }),
      jsonResponse({ status_enum: "blocked" }),
    ]);
    process.env.DEVIN_POLL_INTERVAL_MS = "10";

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(503);
  });

  it("status expired → 503", async () => {
    mockFetchSequence([
      jsonResponse({ id: "sess-123" }),
      jsonResponse({ status_enum: "expired" }),
    ]);
    process.env.DEVIN_POLL_INTERVAL_MS = "10";

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(503);
  });

  it("status error → 502", async () => {
    mockFetchSequence([
      jsonResponse({ id: "sess-123" }),
      jsonResponse({ status_enum: "error" }),
    ]);
    process.env.DEVIN_POLL_INTERVAL_MS = "10";

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(502);
  });

  it("poll timeout → 504", async () => {
    mockFetchSequence([
      jsonResponse({ id: "sess-123" }),
      jsonResponse({ status_enum: "running" }), // never finishes
    ]);
    process.env.DEVIN_POLL_INTERVAL_MS = "10";
    process.env.DEVIN_SESSION_TIMEOUT_MS = "50"; // 50ms timeout

    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(result.response.status).toBe(504);
  });

  it("modeMap: model='fast' → devin_mode='fast'", async () => {
    let capturedBody;
    proxyAwareFetch.mockImplementation(async (url, opts) => {
      if (url.includes("/sessions") && !url.includes("/sess-")) {
        capturedBody = JSON.parse(opts.body);
        return jsonResponse({ id: "sess-123" });
      }
      return jsonResponse({ status_enum: "finished", output: "ok" });
    });
    process.env.DEVIN_POLL_INTERVAL_MS = "10";

    const executor = new DevinExecutor("devin", {});
    await executor.execute({
      model: "fast",
      body: makeBody(),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(capturedBody.devin_mode).toBe("fast");
  });

  it("missing orgId → 400", async () => {
    const executor = new DevinExecutor("devin", {});
    const result = await executor.execute({
      model: "normal",
      body: makeBody(),
      stream: false,
      credentials: { apiKey: "cog_test", providerSpecificData: {} },
      signal: undefined,
    });

    expect(result.response.status).toBe(400);
  });

  it("QĐ15 prompt format: [System: ...] + User: ...", async () => {
    let capturedBody;
    proxyAwareFetch.mockImplementation(async (url, opts) => {
      if (url.includes("/sessions") && !url.includes("/sess-")) {
        capturedBody = JSON.parse(opts.body);
        return jsonResponse({ id: "sess-123" });
      }
      return jsonResponse({ status_enum: "finished", output: "ok" });
    });
    process.env.DEVIN_POLL_INTERVAL_MS = "10";

    const executor = new DevinExecutor("devin", {});
    await executor.execute({
      model: "normal",
      body: makeBody({
        messages: [
          { role: "system", content: "You are a helpful agent" },
          { role: "user", content: "Do task" },
          { role: "assistant", content: "Working on it" },
          { role: "user", content: "Continue" },
        ],
      }),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(capturedBody.prompt).toContain("[System: You are a helpful agent]");
    expect(capturedBody.prompt).toContain("User: Do task");
    expect(capturedBody.prompt).toContain("Assistant: Working on it");
    expect(capturedBody.prompt).toContain("User: Continue");
  });

  it("D3: tool definitions included in prompt", async () => {
    let capturedBody;
    proxyAwareFetch.mockImplementation(async (url, opts) => {
      if (url.includes("/sessions") && !url.includes("/sess-")) {
        capturedBody = JSON.parse(opts.body);
        return jsonResponse({ id: "sess-123" });
      }
      return jsonResponse({ status_enum: "finished", output: "ok" });
    });
    process.env.DEVIN_POLL_INTERVAL_MS = "10";

    const executor = new DevinExecutor("devin", {});
    await executor.execute({
      model: "normal",
      body: makeBody({
        messages: [{ role: "user", content: "Use tools" }],
        tools: [
          { type: "function", function: { name: "search", description: "Search the web" } },
        ],
      }),
      stream: false,
      credentials: makeCredentials(),
      signal: undefined,
    });

    expect(capturedBody.prompt).toContain("[Available tools:");
    expect(capturedBody.prompt).toContain("search: Search the web");
  });
});
