import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;
const originalPort = process.env.PORT;

async function loadRoute() {
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return { body, status: init.status || 200 };
      },
    },
  }));
  vi.doMock("@/lib/localDb", () => ({
    getApiKeys: vi.fn().mockResolvedValue([{ key: "test-key", isActive: true }]),
  }));
  vi.doMock("@/shared/constants/config", () => ({
    UPDATER_CONFIG: { appPort: 3000 },
  }));
  vi.doMock("@/shared/utils/machineId", () => ({
    getConsistentMachineId: vi.fn().mockResolvedValue("test-machine-id"),
  }));
  const { POST } = await import("@/app/api/models/test/route.js");
  return POST;
}

function makeRequest(body) {
  return new Request("https://9router.local/api/models/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/models/test — HTTP 200 empty/malformed response", () => {
  let POST;

  beforeEach(async () => {
    process.env.PORT = "3000";
    POST = await loadRoute();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.PORT = originalPort;
    vi.restoreAllMocks();
  });

  it("returns error when HTTP 200 body is empty string", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
    });
    const res = await POST(makeRequest({ model: "gpt-4" }));
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("Provider returned no completion choices for this model");
    expect(res.body.status).toBe(200);
  });

  it("returns error when HTTP 200 body is malformed JSON (proxy HTML page)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("<!DOCTYPE html><html>502 Bad Gateway</html>"),
    });
    const res = await POST(makeRequest({ model: "gpt-4" }));
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("Provider returned no completion choices for this model");
    expect(res.body.status).toBe(200);
  });

  it("returns error when HTTP 200 has choices: []", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ choices: [] })),
    });
    const res = await POST(makeRequest({ model: "gpt-4" }));
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("Provider returned no completion choices for this model");
  });

  it("returns error when HTTP 200 has choices: null", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ choices: null })),
    });
    const res = await POST(makeRequest({ model: "gpt-4" }));
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("Provider returned no completion choices for this model");
  });

  it("returns error when HTTP 200 has no choices field at all", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({ id: "chatcmpl-abc", object: "chat.completion" })),
    });
    const res = await POST(makeRequest({ model: "gpt-4" }));
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("Provider returned no completion choices for this model");
  });

  it("returns ok:true when HTTP 200 has valid choices", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "hi" } }],
          })
        ),
    });
    const res = await POST(makeRequest({ model: "gpt-4" }));
    expect(res.body.ok).toBe(true);
    expect(res.body.error).toBeNull();
  });

  it("returns provider error when HTTP 200 body contains error field", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({ error: { message: "model_not_found" } })),
    });
    const res = await POST(makeRequest({ model: "bad-model" }));
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("model_not_found");
  });

  it("returns HTTP status error when upstream is non-200", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () =>
        Promise.resolve(JSON.stringify({ error: { message: "Unauthorized" } })),
    });
    const res = await POST(makeRequest({ model: "gpt-4" }));
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/HTTP 401/);
  });

  it("returns 400 when model param is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/models/test — embeddings (HTTP 200 empty/malformed)", () => {
  let POST;

  beforeEach(async () => {
    process.env.PORT = "3000";
    POST = await loadRoute();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.PORT = originalPort;
    vi.restoreAllMocks();
  });

  it("returns error when HTTP 200 embedding body is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
    });
    const res = await POST(
      makeRequest({ model: "text-embedding-ada-002", kind: "embedding" })
    );
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("Provider returned no embedding data");
  });

  it("returns error when HTTP 200 embedding body is malformed JSON", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("not-json"),
    });
    const res = await POST(
      makeRequest({ model: "text-embedding-ada-002", kind: "embedding" })
    );
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("Provider returned no embedding data");
  });

  it("returns error when HTTP 200 embedding has data: []", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    });
    const res = await POST(
      makeRequest({ model: "text-embedding-ada-002", kind: "embedding" })
    );
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("Provider returned no embedding data");
  });

  it("returns ok:true when HTTP 200 embedding has valid data", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] })),
    });
    const res = await POST(
      makeRequest({ model: "text-embedding-ada-002", kind: "embedding" })
    );
    expect(res.body.ok).toBe(true);
  });
});
