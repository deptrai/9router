/**
 * D2: Unit tests cho API quota route (AC#9-11, Story 1.3)
 *
 * Phủ: validate pass/fail, 404, GET shape, PUT round-trip (mock quotaRepo).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock các DB repos để test route logic
vi.mock("../../src/lib/localDb.js", () => ({
  getApiKeyById: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/quotaRepo.js", () => ({
  getQuotaConfig: vi.fn(),
  setQuotaConfig: vi.fn(),
  getQuotaState: vi.fn(),
  sumUsageTokens: vi.fn(),
}));
// R4-P0-2 added a requireAdmin guard to this route. This suite tests quota
// logic, not auth — stub requireAdmin to return an admin session so the guard
// is a no-op here (auth itself is covered in auth-specific tests).
vi.mock("../../src/lib/auth/requireRole.js", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ role: "admin", userId: "admin-1" }),
}));

import { getApiKeyById } from "../../src/lib/localDb.js";
import { getQuotaConfig, setQuotaConfig, getQuotaState, sumUsageTokens } from "../../src/lib/db/repos/quotaRepo.js";

// Import route handlers trực tiếp
// Chú ý: Next.js params là Promise trong App Router
import { GET, PUT } from "../../src/app/api/keys/[id]/quota/route.js";

const FAKE_KEY = { id: "key-id-123", key: "sk-test-abc", name: "Test Key", isActive: true };

function makeRequest(body) {
  return {
    json: async () => body,
  };
}

function makeParams(id) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getApiKeyById.mockResolvedValue(FAKE_KEY);
  getQuotaConfig.mockResolvedValue(null);
  getQuotaState.mockResolvedValue({});
  setQuotaConfig.mockResolvedValue();
  sumUsageTokens.mockResolvedValue(0);
});

// ── GET tests ────────────────────────────────────────────────────────────────

describe("GET /api/keys/[id]/quota", () => {
  it("key không tồn tại → 404", async () => {
    getApiKeyById.mockResolvedValue(null);
    const res = await GET(makeRequest(null), makeParams("nonexistent"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("key có config=null → trả config={enabled:false,limits:[]}, usage=[]", async () => {
    getQuotaConfig.mockResolvedValue(null);
    const res = await GET(makeRequest(null), makeParams("key-id-123"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config).toEqual({ enabled: false, limits: [] });
    expect(body.usage).toEqual([]);
  });

  it("key có config enabled=false → usage không tính ([])", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: false, limits: [
      { model: "claude-opus-4.7", window: "5h", maxTokens: 200000 }
    ]});
    const res = await GET(makeRequest(null), makeParams("key-id-123"));
    const body = await res.json();
    expect(body.usage).toEqual([]);
  });

  it("key có config enabled=true → trả usage shape đúng", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "claude-opus-4.7", window: "5h", maxTokens: 200000 }
    ]});
    getQuotaState.mockResolvedValue({});
    sumUsageTokens.mockResolvedValue(50000);

    const res = await GET(makeRequest(null), makeParams("key-id-123"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.usage).toHaveLength(1);
    const u = body.usage[0];
    expect(u.model).toBe("claude-opus-4.7");
    expect(u.window).toBe("5h");
    expect(u.maxTokens).toBe(200000);
    expect(u.consumed).toBe(50000);
    expect(u.resetAt).toBeTruthy(); // ISO string
    expect(u.resetHuman).toMatch(/reset after/);
  });

  it("GET không mutate quotaState (setQuotaConfig không được gọi)", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "*", window: "weekly", maxTokens: 1000000 }
    ]});
    await GET(makeRequest(null), makeParams("key-id-123"));
    expect(setQuotaConfig).not.toHaveBeenCalled();
  });

  it("wildcard limit: sumUsageTokens gọi với model=null", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "*", window: "weekly", maxTokens: 1000000 }
    ]});
    await GET(makeRequest(null), makeParams("key-id-123"));
    // model=null cho wildcard
    expect(sumUsageTokens).toHaveBeenCalledWith("sk-test-abc", null, expect.any(String));
  });
});

// ── PUT tests ────────────────────────────────────────────────────────────────

describe("PUT /api/keys/[id]/quota — validate pass", () => {
  it("valid config → 200 + config trả về", async () => {
    const body = {
      enabled: true,
      limits: [
        { model: "claude-opus-4.7", window: "5h", maxTokens: 200000 },
        { model: "*", window: "weekly", maxTokens: 20000000 },
      ]
    };
    const res = await PUT(makeRequest(body), makeParams("key-id-123"));
    expect(res.status).toBe(200);
    const resBody = await res.json();
    expect(resBody.config.enabled).toBe(true);
    expect(resBody.config.limits).toHaveLength(2);
    expect(setQuotaConfig).toHaveBeenCalledWith("key-id-123", expect.objectContaining({ enabled: true }));
  });

  it("enabled=false với limits=[] → valid", async () => {
    const body = { enabled: false, limits: [] };
    const res = await PUT(makeRequest(body), makeParams("key-id-123"));
    expect(res.status).toBe(200);
  });

  it("maxTokens là string number → normalize về integer", async () => {
    const body = {
      enabled: true,
      limits: [{ model: "claude-opus-4.7", window: "5h", maxTokens: "200000" }]
    };
    const res = await PUT(makeRequest(body), makeParams("key-id-123"));
    expect(res.status).toBe(200);
    const resBody = await res.json();
    expect(resBody.config.limits[0].maxTokens).toBe(200000);
  });
});

describe("PUT /api/keys/[id]/quota — validate fail → 400", () => {
  it("key không tồn tại → 404", async () => {
    getApiKeyById.mockResolvedValue(null);
    const body = { enabled: true, limits: [] };
    const res = await PUT(makeRequest(body), makeParams("nonexistent"));
    expect(res.status).toBe(404);
  });

  it("enabled không phải boolean → 400", async () => {
    const body = { enabled: "yes", limits: [] };
    const res = await PUT(makeRequest(body), makeParams("key-id-123"));
    expect(res.status).toBe(400);
    const resBody = await res.json();
    expect(resBody.error).toMatch(/boolean/);
  });

  it("limits không phải array → 400", async () => {
    const body = { enabled: true, limits: "not-array" };
    const res = await PUT(makeRequest(body), makeParams("key-id-123"));
    expect(res.status).toBe(400);
    const resBody = await res.json();
    expect(resBody.error).toMatch(/array/);
  });

  it("limit.model rỗng → 400", async () => {
    const body = { enabled: true, limits: [{ model: "", window: "5h", maxTokens: 1000 }] };
    const res = await PUT(makeRequest(body), makeParams("key-id-123"));
    expect(res.status).toBe(400);
    const resBody = await res.json();
    expect(resBody.error).toMatch(/model/);
  });

  it("limit.window không hợp lệ → 400", async () => {
    const body = { enabled: true, limits: [{ model: "claude", window: "daily", maxTokens: 1000 }] };
    const res = await PUT(makeRequest(body), makeParams("key-id-123"));
    expect(res.status).toBe(400);
    const resBody = await res.json();
    expect(resBody.error).toMatch(/window/);
  });

  it("limit.maxTokens = 0 → 400", async () => {
    const body = { enabled: true, limits: [{ model: "claude", window: "5h", maxTokens: 0 }] };
    const res = await PUT(makeRequest(body), makeParams("key-id-123"));
    expect(res.status).toBe(400);
    const resBody = await res.json();
    expect(resBody.error).toMatch(/maxTokens/);
  });

  it("limit.maxTokens âm → 400", async () => {
    const body = { enabled: true, limits: [{ model: "claude", window: "5h", maxTokens: -100 }] };
    const res = await PUT(makeRequest(body), makeParams("key-id-123"));
    expect(res.status).toBe(400);
  });

  it("limit.maxTokens không phải số → 400", async () => {
    const body = { enabled: true, limits: [{ model: "claude", window: "5h", maxTokens: "abc" }] };
    const res = await PUT(makeRequest(body), makeParams("key-id-123"));
    expect(res.status).toBe(400);
  });
});

describe("PUT round-trip: save rồi GET lại", () => {
  it("PUT lưu → GET trả đúng config", async () => {
    const config = {
      enabled: true,
      limits: [{ model: "claude-opus-4.7", window: "5h", maxTokens: 100000 }]
    };

    // PUT
    const putRes = await PUT(makeRequest(config), makeParams("key-id-123"));
    expect(putRes.status).toBe(200);

    // Mock getQuotaConfig trả lại config đã lưu
    getQuotaConfig.mockResolvedValue(config);

    // GET
    const getRes = await GET(makeRequest(null), makeParams("key-id-123"));
    const body = await getRes.json();
    expect(body.config.enabled).toBe(true);
    expect(body.config.limits[0].model).toBe("claude-opus-4.7");
  });
});
