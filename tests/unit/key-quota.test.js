/**
 * Unit tests cho Quota per API Key (Story 1.3)
 *
 * Phủ: window reset 5h/weekly, sum model vs *, multi-limit all-must-pass,
 *      fail-open, no-config passthrough, null-key allow, combo fallback verify.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Kiểm thử window.js trực tiếp (pure logic, không cần DB) ─────────────────
import { duration, resolveWindow, formatResetCountdown } from "../../src/lib/quota/window.js";

describe("window.js — duration()", () => {
  it("5h = 18,000,000 ms", () => {
    expect(duration("5h")).toBe(5 * 3600 * 1000);
  });

  it("weekly = 604,800,000 ms", () => {
    expect(duration("weekly")).toBe(7 * 24 * 3600 * 1000);
  });

  it("unknown type throws", () => {
    expect(() => duration("daily")).toThrow("Unknown window type");
  });
});

describe("window.js — resolveWindow()", () => {
  const NOW = new Date("2026-06-10T10:00:00.000Z").getTime();

  it("state=null → reset với startedAt=now", () => {
    const { startedAt, reset } = resolveWindow(null, "5h", NOW);
    expect(reset).toBe(true);
    expect(startedAt).toBe(new Date(NOW).toISOString());
  });

  it("state.startedAt undefined → reset", () => {
    const { reset } = resolveWindow({}, "5h", NOW);
    expect(reset).toBe(true);
  });

  it("chưa hết hạn → giữ nguyên startedAt, reset=false", () => {
    const startedAt = new Date(NOW - 1 * 3600 * 1000).toISOString(); // 1h trước
    const result = resolveWindow({ startedAt }, "5h", NOW);
    expect(result.reset).toBe(false);
    expect(result.startedAt).toBe(startedAt);
  });

  it("5h đúng hạn → reset", () => {
    const startedAt = new Date(NOW - 5 * 3600 * 1000).toISOString(); // đúng 5h
    const { reset } = resolveWindow({ startedAt }, "5h", NOW);
    expect(reset).toBe(true);
  });

  it("5h vượt hạn → reset", () => {
    const startedAt = new Date(NOW - 6 * 3600 * 1000).toISOString(); // 6h trước
    const { reset } = resolveWindow({ startedAt }, "5h", NOW);
    expect(reset).toBe(true);
  });

  it("weekly chưa hết hạn → giữ nguyên", () => {
    const startedAt = new Date(NOW - 2 * 86400 * 1000).toISOString(); // 2 ngày trước
    const { reset } = resolveWindow({ startedAt }, "weekly", NOW);
    expect(reset).toBe(false);
  });

  it("weekly đúng 7 ngày → reset", () => {
    const startedAt = new Date(NOW - 7 * 86400 * 1000).toISOString();
    const { reset } = resolveWindow({ startedAt }, "weekly", NOW);
    expect(reset).toBe(true);
  });

  it("startedAt invalid ISO → reset", () => {
    const { reset } = resolveWindow({ startedAt: "not-a-date" }, "5h", NOW);
    expect(reset).toBe(true);
  });
});

describe("window.js — formatResetCountdown()", () => {
  const NOW = new Date("2026-06-10T10:00:00.000Z").getTime();

  it("nhiều hơn 1h → 'reset after Xh Ym'", () => {
    const resetAt = new Date(NOW + 2 * 3600 * 1000 + 30 * 60 * 1000).toISOString();
    expect(formatResetCountdown(resetAt, NOW)).toBe("reset after 2h 30m");
  });

  it("dưới 1h → 'reset after Xm'", () => {
    const resetAt = new Date(NOW + 45 * 60 * 1000).toISOString();
    expect(formatResetCountdown(resetAt, NOW)).toBe("reset after 45m");
  });

  it("đã qua reset → 'resetting...'", () => {
    const resetAt = new Date(NOW - 1000).toISOString();
    expect(formatResetCountdown(resetAt, NOW)).toBe("resetting...");
  });

  it("resetAt rỗng → ''", () => {
    expect(formatResetCountdown("", NOW)).toBe("");
  });
});

// ── Kiểm thử checkKeyQuota với mock repos ────────────────────────────────────
// Vi mock các module DB để test logic thuần túy
vi.mock("../../src/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/quotaRepo.js", () => ({
  getQuotaConfig: vi.fn(),
  getQuotaState: vi.fn(),
  setQuotaState: vi.fn(),
  sumUsageTokens: vi.fn(),
}));
// Mock logger để tránh import sse/utils/logger
vi.mock("../../src/sse/utils/logger.js", () => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

import { checkKeyQuota } from "../../src/lib/quota/keyQuota.js";
import { getApiKeyByKey } from "../../src/lib/db/repos/apiKeysRepo.js";
import { getQuotaConfig, getQuotaState, setQuotaState, sumUsageTokens } from "../../src/lib/db/repos/quotaRepo.js";

const FAKE_KEY = { id: "key-id-123", key: "sk-test-abc", name: "Test Key", isActive: true };
const NOW_TS = new Date("2026-06-10T10:00:00.000Z").getTime();

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults
  getApiKeyByKey.mockResolvedValue(FAKE_KEY);
  getQuotaState.mockResolvedValue({});
  setQuotaState.mockResolvedValue();
  sumUsageTokens.mockResolvedValue(0);
});

describe("checkKeyQuota — null key", () => {
  it("null → allowed (AC#8b)", async () => {
    const result = await checkKeyQuota(null, "claude-opus-4.7");
    expect(result.allowed).toBe(true);
    expect(getApiKeyByKey).not.toHaveBeenCalled();
  });

  it("empty string → allowed (AC#8b)", async () => {
    const result = await checkKeyQuota("", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });
});

describe("checkKeyQuota — no config / disabled (AC#5)", () => {
  it("key không tìm thấy → allowed", async () => {
    getApiKeyByKey.mockResolvedValue(null);
    const result = await checkKeyQuota("sk-unknown", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });

  it("config = null → allowed", async () => {
    getQuotaConfig.mockResolvedValue(null);
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });

  it("config.enabled=false → allowed", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: false, limits: [
      { model: "claude-opus-4.7", window: "5h", maxTokens: 100 }
    ]});
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });

  it("limits=[] → allowed", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [] });
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });

  it("không có limit nào áp cho model hiện tại → allowed", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "claude-sonnet-4.6", window: "5h", maxTokens: 100 }
    ]});
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });
});

describe("checkKeyQuota — below limit (AC#1,2,7)", () => {
  it("consumed < maxTokens → allowed", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "claude-opus-4.7", window: "5h", maxTokens: 200000 }
    ]});
    sumUsageTokens.mockResolvedValue(100000);
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });

  it("wildcard limit * consumed < max → allowed", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "*", window: "weekly", maxTokens: 20000000 }
    ]});
    sumUsageTokens.mockResolvedValue(5000000);
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
    // sumUsageTokens phải được gọi với model=null (wildcard)
    expect(sumUsageTokens).toHaveBeenCalledWith("sk-test-abc", null, expect.any(String));
  });
});

describe("checkKeyQuota — at/over limit → block (AC#1,2)", () => {
  it("consumed === maxTokens → block với 429", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "claude-opus-4.7", window: "5h", maxTokens: 200000 }
    ]});
    sumUsageTokens.mockResolvedValue(200000);
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeTruthy();
    expect(result.retryAfterHuman).toBeTruthy();
    expect(result.limit.model).toBe("claude-opus-4.7");
    expect(result.limit.consumed).toBe(200000);
  });

  it("consumed > maxTokens → block", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "*", window: "weekly", maxTokens: 10000 }
    ]});
    sumUsageTokens.mockResolvedValue(15000);
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(false);
  });
});

describe("checkKeyQuota — multi-limit all-must-pass (AC#7)", () => {
  it("model-specific OK nhưng wildcard exceeded → block", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "claude-opus-4.7", window: "5h", maxTokens: 200000 },
      { model: "*", window: "weekly", maxTokens: 500000 },
    ]});
    sumUsageTokens
      .mockResolvedValueOnce(100000)   // model-specific: OK
      .mockResolvedValueOnce(600000);  // wildcard: exceeded
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(false);
  });

  it("cả hai limits OK → allowed", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "claude-opus-4.7", window: "5h", maxTokens: 200000 },
      { model: "*", window: "weekly", maxTokens: 5000000 },
    ]});
    sumUsageTokens
      .mockResolvedValueOnce(100000)   // model-specific: OK
      .mockResolvedValueOnce(1000000); // wildcard: OK
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });
});

describe("checkKeyQuota — window reset (AC#3)", () => {
  it("window 5h mới khởi tạo (state={}): persist startedAt", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "claude-opus-4.7", window: "5h", maxTokens: 200000 }
    ]});
    getQuotaState.mockResolvedValue({});
    sumUsageTokens.mockResolvedValue(0);

    await checkKeyQuota("sk-test-abc", "claude-opus-4.7");

    expect(setQuotaState).toHaveBeenCalledOnce();
    const saved = setQuotaState.mock.calls[0][1];
    expect(saved.win5h?.startedAt).toBeTruthy();
  });

  it("window đã hết hạn: reset startedAt về now", async () => {
    const oldStart = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "claude-opus-4.7", window: "5h", maxTokens: 200000 }
    ]});
    getQuotaState.mockResolvedValue({ win5h: { startedAt: oldStart } });
    sumUsageTokens.mockResolvedValue(0);

    await checkKeyQuota("sk-test-abc", "claude-opus-4.7");

    expect(setQuotaState).toHaveBeenCalled();
    const saved = setQuotaState.mock.calls[0][1];
    // startedAt mới phải khác oldStart
    expect(saved.win5h?.startedAt).not.toBe(oldStart);
  });

  it("window chưa hết hạn: không cần persist", async () => {
    const recentStart = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "claude-opus-4.7", window: "5h", maxTokens: 200000 }
    ]});
    getQuotaState.mockResolvedValue({ win5h: { startedAt: recentStart } });
    sumUsageTokens.mockResolvedValue(0);

    await checkKeyQuota("sk-test-abc", "claude-opus-4.7");

    expect(setQuotaState).not.toHaveBeenCalled();
  });
});

describe("checkKeyQuota — fail-open (AC#6)", () => {
  it("DB error → allowed (fail-open)", async () => {
    getApiKeyByKey.mockRejectedValue(new Error("DB connection failed"));
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });

  it("getQuotaConfig throws → allowed (fail-open)", async () => {
    getQuotaConfig.mockRejectedValue(new Error("Parse error"));
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });

  it("sumUsageTokens throws → allowed (fail-open)", async () => {
    getQuotaConfig.mockResolvedValue({ enabled: true, limits: [
      { model: "*", window: "5h", maxTokens: 200000 }
    ]});
    getQuotaState.mockResolvedValue({});
    sumUsageTokens.mockRejectedValue(new Error("Query failed"));
    const result = await checkKeyQuota("sk-test-abc", "claude-opus-4.7");
    expect(result.allowed).toBe(true);
  });
});
