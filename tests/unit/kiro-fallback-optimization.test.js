import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const originalDateNow = Date.now;

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  Date.now = originalDateNow;
});

describe("Patch B — backoff recalibration", () => {
  it("uses 8s, 16s, 32s progression and caps at 10 minutes", async () => {
    const { getQuotaCooldown } = await import("../../open-sse/services/accountFallback.js");

    expect(getQuotaCooldown(0)).toBe(8000);
    expect(getQuotaCooldown(1)).toBe(8000);
    expect(getQuotaCooldown(2)).toBe(16000);
    expect(getQuotaCooldown(3)).toBe(32000);
    expect(getQuotaCooldown(20)).toBe(10 * 60 * 1000);
  });

  it("still prefers resetsAtMs over exponential backoff", async () => {
    const baseNow = 1_700_000_000_000;
    Date.now = vi.fn(() => baseNow);

    const updateProviderConnection = vi.fn(async () => ({}));
    const getProviderConnections = vi.fn(async () => ([{
      id: "conn-1",
      providerSpecificData: {},
      backoffLevel: 0,
      testStatus: "active",
      lastError: null,
      errorCode: null,
      displayName: "Conn 1",
    }]));

    vi.doMock("@/lib/localDb", () => ({
      getProviderConnections,
      updateProviderConnection,
      validateApiKey: vi.fn(),
      getSettings: vi.fn(),
    }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      resolveConnectionProxyConfig: vi.fn(async () => ({
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: true,
        proxyPoolId: null,
        vercelRelayUrl: "",
      })),
    }));
    vi.doMock("@/shared/constants/providers.js", () => ({
      resolveProviderId: vi.fn((p) => p),
      FREE_PROVIDERS: {},
    }));
    vi.doMock("../utils/logger.js", () => ({
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }));

    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
    const result = await markAccountUnavailable("conn-1", 429, "rate limit", "kiro", "kiro/auto", baseNow + 1000);

    expect(result.cooldownMs).toBeLessThanOrEqual(1000);
    expect(updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({
      lastErrorAt: expect.any(String),
      backoffLevel: 0,
    }));
  });
});

describe("Patch D/C — auth selection and negative cache", () => {
  let getProviderCredentials;
  let getProviderConnections;
  let updateProviderConnection;
  let getSettings;

  beforeEach(async () => {
    const baseNow = 1_700_000_000_000;
    Date.now = vi.fn(() => baseNow);

    getProviderConnections = vi.fn();
    updateProviderConnection = vi.fn(async () => ({}));
    getSettings = vi.fn(async () => ({
      providerStrategies: {},
      fallbackStrategy: "fill-first",
      stickyRoundRobinLimit: 3,
    }));

    vi.doMock("@/lib/localDb", () => ({
      getProviderConnections,
      updateProviderConnection,
      validateApiKey: vi.fn(),
      getSettings,
    }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      resolveConnectionProxyConfig: vi.fn(async () => ({
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: true,
        proxyPoolId: null,
        vercelRelayUrl: "",
      })),
    }));
    vi.doMock("@/shared/constants/providers.js", () => ({
      resolveProviderId: vi.fn((p) => p),
      FREE_PROVIDERS: {},
    }));
    vi.doMock("../utils/logger.js", () => ({
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }));

    ({ getProviderCredentials } = await import("../../src/sse/services/auth.js"));
  });

  it("prefers a healthy account over one that failed recently", async () => {
    getProviderConnections.mockResolvedValue([
      {
        id: "a",
        priority: 1,
        lastErrorAt: new Date(Date.now() - 10_000).toISOString(),
        providerSpecificData: {},
      },
      {
        id: "b",
        priority: 2,
        lastErrorAt: null,
        providerSpecificData: {},
      },
    ]);

    const creds = await getProviderCredentials("kiro", null, "kiro/auto");
    expect(creds.connectionId).toBe("b");
  });

  it("still selects the only available account even if it failed recently", async () => {
    getProviderConnections.mockResolvedValue([
      {
        id: "a",
        priority: 1,
        lastErrorAt: new Date(Date.now() - 10_000).toISOString(),
        providerSpecificData: {},
      },
    ]);

    const creds = await getProviderCredentials("kiro", null, "kiro/auto");
    expect(creds.connectionId).toBe("a");
  });

  it("returns cached all-locked state on a second call and clears cache after success", async () => {
    const baseNow = 1_700_000_000_000;
    Date.now = vi.fn(() => baseNow);
    const lockedUntil = new Date(baseNow + 5_000).toISOString();
    getProviderConnections
      .mockResolvedValueOnce([
        {
          id: "a",
          priority: 1,
          "modelLock_kiro/auto": lockedUntil,
          providerSpecificData: {},
        },
        {
          id: "b",
          priority: 2,
          "modelLock_kiro/auto": lockedUntil,
          providerSpecificData: {},
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "a",
          priority: 1,
          providerSpecificData: {},
        },
        {
          id: "b",
          priority: 2,
          providerSpecificData: {},
        },
      ]);

    const first = await getProviderCredentials("kiro", null, "kiro/auto");
    expect(first.allRateLimited).toBe(true);
    expect(first._cached).toBeUndefined();
    expect(getProviderConnections).toHaveBeenCalledTimes(1);

    const second = await getProviderCredentials("kiro", null, "kiro/auto");
    expect(second.allRateLimited).toBe(true);
    expect(second._cached).toBe(true);
    expect(getProviderConnections).toHaveBeenCalledTimes(1);

    Date.now = vi.fn(() => baseNow + 3000);
    getProviderConnections.mockClear();
    updateProviderConnection.mockResolvedValueOnce({});
    getProviderConnections.mockResolvedValueOnce([
      {
        id: "a",
        priority: 1,
        providerSpecificData: {},
      },
      {
        id: "b",
        priority: 2,
        providerSpecificData: {},
      },
    ]);

    const third = await getProviderCredentials("kiro", null, "kiro/auto");
    expect(third.connectionId).toBe("a");
    expect(getProviderConnections).toHaveBeenCalledTimes(1);
  });
});
