/**
 * Story 1.6 guardrail — auth.js edge paths
 * Covers: negative cache skipped when excludeSet non-empty,
 *         cache key isolation by model, markAccountUnavailable with
 *         expired resetsAtMs falls back to backoff.
 */
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

function makeConn(id, overrides = {}) {
  return {
    id,
    priority: 1,
    providerSpecificData: {},
    lastErrorAt: null,
    ...overrides,
  };
}

function mockDeps({ connections, settings } = {}) {
  vi.doMock("@/lib/localDb", () => ({
    getProviderConnections: vi.fn(async () => connections ?? []),
    updateProviderConnection: vi.fn(async () => ({})),
    validateApiKey: vi.fn(),
    getSettings: vi.fn(async () => settings ?? {
      providerStrategies: {},
      fallbackStrategy: "fill-first",
      stickyRoundRobinLimit: 3,
    }),
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
}

// ---------------------------------------------------------------------------
// Negative cache NOT populated when excludeSet is non-empty (AC#6 constraint)
// ---------------------------------------------------------------------------
describe("Negative cache — skipped when excludeSet non-empty", () => {
  it("does NOT return cached result when excludeConnectionIds is provided", async () => {
    const baseNow = 1_700_000_000_000;
    Date.now = vi.fn(() => baseNow);

    const lockedUntil = new Date(baseNow + 10_000).toISOString();
    const getProviderConnections = vi.fn(async () => [
      makeConn("a", { [`modelLock_kiro/auto`]: lockedUntil }),
    ]);

    vi.doMock("@/lib/localDb", () => ({
      getProviderConnections,
      updateProviderConnection: vi.fn(async () => ({})),
      validateApiKey: vi.fn(),
      getSettings: vi.fn(async () => ({
        providerStrategies: {},
        fallbackStrategy: "fill-first",
        stickyRoundRobinLimit: 3,
      })),
    }));

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

    // First call without excludeSet — populates cache
    getProviderConnections.mockResolvedValueOnce([
      makeConn("a", { [`modelLock_kiro/auto`]: lockedUntil }),
    ]);
    const first = await getProviderCredentials("kiro", null, "kiro/auto");
    expect(first.allRateLimited).toBe(true);

    // Second call WITH excludeSet — must NOT hit cache, must query DB
    getProviderConnections.mockResolvedValueOnce([
      makeConn("a", { [`modelLock_kiro/auto`]: lockedUntil }),
    ]);
    const callCountBefore = getProviderConnections.mock.calls.length;
    await getProviderCredentials("kiro", new Set(["other-conn"]), "kiro/auto");
    expect(getProviderConnections.mock.calls.length).toBeGreaterThan(callCountBefore);
  });
});

// ---------------------------------------------------------------------------
// Negative cache key isolation — different models have separate cache entries
// ---------------------------------------------------------------------------
describe("Negative cache — key isolation by model", () => {
  it("all-locked for kiro/auto does NOT block kiro/sonnet query", async () => {
    const baseNow = 1_700_000_000_000;
    Date.now = vi.fn(() => baseNow);

    const lockedUntil = new Date(baseNow + 10_000).toISOString();
    const getProviderConnections = vi.fn();

    vi.doMock("@/lib/localDb", () => ({
      getProviderConnections,
      updateProviderConnection: vi.fn(async () => ({})),
      validateApiKey: vi.fn(),
      getSettings: vi.fn(async () => ({
        providerStrategies: {},
        fallbackStrategy: "fill-first",
        stickyRoundRobinLimit: 3,
      })),
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
      debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(),
    }));

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

    // Lock kiro/auto
    getProviderConnections.mockResolvedValueOnce([
      makeConn("a", { [`modelLock_kiro/auto`]: lockedUntil }),
    ]);
    const first = await getProviderCredentials("kiro", null, "kiro/auto");
    expect(first.allRateLimited).toBe(true);

    // kiro/sonnet should still query DB (different cache key)
    getProviderConnections.mockResolvedValueOnce([makeConn("a")]);
    const dbCallsBefore = getProviderConnections.mock.calls.length;
    const second = await getProviderCredentials("kiro", null, "kiro/sonnet");
    expect(getProviderConnections.mock.calls.length).toBeGreaterThan(dbCallsBefore);
    expect(second?.allRateLimited).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// markAccountUnavailable — expired resetsAtMs falls back to exponential backoff
// ---------------------------------------------------------------------------
describe("markAccountUnavailable — expired resetsAtMs uses backoff", () => {
  it("resetsAtMs in the past → uses checkFallbackError backoff, not resetsAtMs", async () => {
    const baseNow = 1_700_000_000_000;
    Date.now = vi.fn(() => baseNow);

    const updateProviderConnection = vi.fn(async () => ({}));

    vi.doMock("@/lib/localDb", () => ({
      getProviderConnections: vi.fn(async () => [{
        id: "conn-1",
        backoffLevel: 0,
        providerSpecificData: {},
      }]),
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
      debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(),
    }));

    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

    // resetsAtMs is 5s in the PAST — should be ignored, use backoff instead
    const expiredResetsAt = baseNow - 5000;
    const result = await markAccountUnavailable(
      "conn-1", 429, "rate limit", "kiro", "kiro/auto", expiredResetsAt
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThanOrEqual(8000);

    // backoffLevel should have been incremented
    expect(updateProviderConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ backoffLevel: 1 })
    );
  });
});

describe("markAccountUnavailable — request-shape 400 does not lock account", () => {
  it("Kiro 'Improperly formed request' returns no fallback and does not update modelLock", async () => {
    const baseNow = 1_700_000_000_000;
    Date.now = vi.fn(() => baseNow);

    const updateProviderConnection = vi.fn(async () => ({}));

    vi.doMock("@/lib/localDb", () => ({
      getProviderConnections: vi.fn(async () => [{
        id: "conn-1",
        backoffLevel: 0,
        providerSpecificData: {},
      }]),
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
      debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(),
    }));

    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

    const result = await markAccountUnavailable(
      "conn-1",
      400,
      "Improperly formed request.",
      "kiro",
      "claude-opus-4.8",
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("markAccountUnavailable — fatal auth errors lock the whole account", () => {
  it("Codex token_invalidated uses modelLock___all instead of a per-model lock", async () => {
    const baseNow = 1_700_000_000_000;
    Date.now = vi.fn(() => baseNow);

    const updateProviderConnection = vi.fn(async () => ({}));

    vi.doMock("@/lib/localDb", () => ({
      getProviderConnections: vi.fn(async () => [{
        id: "conn-1",
        backoffLevel: 0,
        providerSpecificData: {},
      }]),
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
      debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(),
    }));

    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

    const result = await markAccountUnavailable(
      "conn-1",
      401,
      "Your authentication token has been invalidated. Please try signing in again. (code=token_invalidated)",
      "codex",
      "gpt-5.5",
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(24 * 60 * 60 * 1000);
    expect(updateProviderConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({
        modelLock___all: new Date(baseNow + 24 * 60 * 60 * 1000).toISOString(),
        testStatus: "unavailable",
        errorCode: 401,
      }),
    );
    expect(updateProviderConnection.mock.calls[0][1]).not.toHaveProperty("modelLock_gpt-5.5");
  });
});
