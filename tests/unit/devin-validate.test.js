/**
 * Story N.1 — AC3: Validate API key + org_id qua POST /api/providers/validate (provider=devin).
 * Mock fetch globally; gọi trực tiếp POST handler với Request object.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

// POST handler import sau khi fetch mock sẵn (mock được reset mỗi test)
import { POST } from "@/app/api/providers/validate/route.js";

function makeRequest(body) {
  return new Request("https://router.local/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockFetchStatus(status) {
  global.fetch = vi.fn().mockResolvedValue({ status, ok: status >= 200 && status < 300 });
}

describe("Story N.1 — Validate Devin API key + org_id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("200 → { valid: true }, gọi đúng URL v3 với Bearer", async () => {
    mockFetchStatus(200);
    const res = await POST(makeRequest({
      provider: "devin",
      apiKey: "cog_test_key",
      providerSpecificData: { orgId: "org_abc" },
    }));
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.devin.ai/v3/organizations/org_abc/sessions");
    expect(opts.headers.Authorization).toBe("Bearer cog_test_key");
  });

  it("401 → { valid: false, error: 'Invalid API key or org_id' }", async () => {
    mockFetchStatus(401);
    const res = await POST(makeRequest({
      provider: "devin",
      apiKey: "cog_bad",
      providerSpecificData: { orgId: "org_abc" },
    }));
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe("Invalid API key or org_id");
  });

  it("403 → { valid: false }", async () => {
    mockFetchStatus(403);
    const res = await POST(makeRequest({
      provider: "devin",
      apiKey: "cog_forbidden",
      providerSpecificData: { orgId: "org_abc" },
    }));
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it("thiếu org_id → { valid: false, error: 'Missing Organization ID' }, KHÔNG gọi fetch", async () => {
    global.fetch = vi.fn();
    const res = await POST(makeRequest({
      provider: "devin",
      apiKey: "cog_test_key",
      providerSpecificData: {},
    }));
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe("Missing Organization ID");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("404 (org_id không tồn tại) → { valid: false, error: 'Organization ID not found' }", async () => {
    // Best practice: 404 = org_id sai → invalid (không phải "key OK nhưng org sai")
    mockFetchStatus(404);
    const res = await POST(makeRequest({
      provider: "devin",
      apiKey: "cog_test_key",
      providerSpecificData: { orgId: "org_nonexistent" },
    }));
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe("Organization ID not found");
  });

  it("500 (Devin API down) → { valid: false, error: 'Devin API unavailable, try again' }", async () => {
    // Best practice: 5xx = API down → KHÔNG lie valid:true
    mockFetchStatus(503);
    const res = await POST(makeRequest({
      provider: "devin",
      apiKey: "cog_test_key",
      providerSpecificData: { orgId: "org_abc" },
    }));
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe("Devin API unavailable, try again");
  });
});
