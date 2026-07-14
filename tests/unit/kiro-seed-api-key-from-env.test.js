/**
 * Unit tests for seedKiroApiKeyFromEnv
 *
 * Covers:
 *  - Creates a Kiro API-key connection when KIRO_API_KEY env is set and no existing key
 *  - Skips duplicate seed when connection already exists
 *  - No-ops when env var is absent
 *  - Logs but swallows validation errors
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  delete process.env.KIRO_API_KEY;
  delete process.env.KIRO_API_KEY_REGION;
});

afterEach(() => {
  process.env = originalEnv;
});

function mockDeps({ existing = [], throwValidate = null } = {}) {
  let captured = null;

  vi.doMock("@/models", () => ({
    getProviderConnections: vi.fn(async () => existing),
    createProviderConnection: vi.fn(async (data) => {
      captured = data;
      return { id: "seed-conn-1", ...data };
    }),
  }));

  vi.doMock("@/lib/oauth/services/kiro.js", () => ({
    KiroService: class {
      async validateApiKey(key, region) {
        if (throwValidate) throw throwValidate;
        expect(key).toBe("ksk_seed_test");
        expect(region).toBe(process.env.KIRO_API_KEY_REGION || "us-east-1");
        return {
          accessToken: key,
          profileArn: "arn:aws:codewhisperer:us-east-1:111111111111:profile/SEED",
          region,
        };
      }
      extractEmailFromJWT() {
        return "seed@example.com";
      }
    },
  }));

  return { getCaptured: () => captured };
}

describe("seedKiroApiKeyFromEnv", () => {
  it("creates a connection when env key is set and no existing key", async () => {
    process.env.KIRO_API_KEY = "ksk_seed_test";
    process.env.KIRO_API_KEY_REGION = "us-west-2";
    const { getCaptured } = mockDeps({ existing: [] });

    const { seedKiroApiKeyFromEnv } = await import("@/lib/kiro/seedApiKeyFromEnv.js");
    await seedKiroApiKeyFromEnv();

    const captured = getCaptured();
    expect(captured).not.toBeNull();
    expect(captured.provider).toBe("kiro");
    expect(captured.authType).toBe("apikey");
    expect(captured.accessToken).toBe("ksk_seed_test");
    expect(captured.providerSpecificData.authMethod).toBe("api_key");
    expect(captured.providerSpecificData.region).toBe("us-west-2");
    expect(captured.email).toBe("seed@example.com");
    expect(captured.refreshToken).toBeNull();
  });

  it("skips seed when an active api_key connection with same token exists", async () => {
    process.env.KIRO_API_KEY = "ksk_seed_test";
    const { getCaptured } = mockDeps({
      existing: [
        {
          id: "existing",
          provider: "kiro",
          authType: "apikey",
          accessToken: "ksk_seed_test",
          isActive: 1,
          providerSpecificData: { authMethod: "api_key" },
        },
      ],
    });

    const { seedKiroApiKeyFromEnv } = await import("@/lib/kiro/seedApiKeyFromEnv.js");
    await seedKiroApiKeyFromEnv();

    expect(getCaptured()).toBeNull();
  });

  it("no-ops when KIRO_API_KEY is not set", async () => {
    const { getCaptured } = mockDeps({ existing: [] });

    const { seedKiroApiKeyFromEnv } = await import("@/lib/kiro/seedApiKeyFromEnv.js");
    await seedKiroApiKeyFromEnv();

    expect(getCaptured()).toBeNull();
  });

  it("swallows validation errors without throwing", async () => {
    process.env.KIRO_API_KEY = "ksk_seed_test";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockDeps({ existing: [], throwValidate: new Error("Invalid key") });

    const { seedKiroApiKeyFromEnv } = await import("@/lib/kiro/seedApiKeyFromEnv.js");
    await expect(seedKiroApiKeyFromEnv()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[KiroSeed]"),
      expect.stringContaining("Invalid key")
    );
    consoleSpy.mockRestore();
  });
});
