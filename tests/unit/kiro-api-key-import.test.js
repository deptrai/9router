/**
 * Unit tests for POST /api/oauth/kiro/api-key
 *
 * Covers:
 *  - Successful import of a Kiro API key
 *  - Validation failure routing (422 vs 500)
 *  - Missing key returns 400
 *  - Persisted connection has authMethod="api_key" and no refreshToken
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const originalFetch = global.fetch;

function mockRequest({ apiKey = "ksk_test", region = "us-east-1" } = {}) {
  return {
    json: vi.fn().mockResolvedValue({ apiKey, region }),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

describe("Kiro API key import route", () => {
  it("imports a valid API key and stores authMethod=api_key", async () => {
    const created = {
      id: "conn-123",
      provider: "kiro",
      email: "test@example.com",
    };

    vi.doMock("@/models", () => ({
      createProviderConnection: vi.fn(async (data) => {
        expect(data.provider).toBe("kiro");
        expect(data.authType).toBe("apikey");
        expect(data.refreshToken).toBeNull();
        expect(data.providerSpecificData.authMethod).toBe("api_key");
        expect(data.providerSpecificData.profileArn).toBe("arn:aws:codewhisperer:us-east-1:123456789012:profile/TEST");
        expect(data.accessToken).toBe("ksk_test");
        expect(data.testStatus).toBe("active");
        return created;
      }),
    }));

    vi.doMock("@/lib/oauth/services/kiro", () => ({
      KiroService: class {
        async validateApiKey(key, region) {
          expect(key).toBe("ksk_test");
          expect(region).toBe("us-east-1");
          return {
            accessToken: key,
            profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/TEST",
            region,
          };
        }
        extractEmailFromJWT() {
          return "test@example.com";
        }
      },
    }));

    const { POST } = await import("@/app/api/oauth/kiro/api-key/route.js");
    const res = await POST(mockRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.connection.id).toBe("conn-123");
  });

  it("returns 400 when API key is missing", async () => {
    vi.doMock("@/models", () => ({
      createProviderConnection: vi.fn(),
    }));
    vi.doMock("@/lib/oauth/services/kiro", () => ({
      KiroService: class {},
    }));

    const { POST } = await import("@/app/api/oauth/kiro/api-key/route.js");
    const res = await POST(mockRequest({ apiKey: "" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("API key is required");
  });

  it("returns 422 when validation fails with Profile listing failed", async () => {
    vi.doMock("@/models", () => ({
      createProviderConnection: vi.fn(),
    }));
    vi.doMock("@/lib/oauth/services/kiro", () => ({
      KiroService: class {
        async validateApiKey() {
          const err = new Error("Profile listing failed: 403");
          throw err;
        }
      },
    }));

    const { POST } = await import("@/app/api/oauth/kiro/api-key/route.js");
    const res = await POST(mockRequest());

    expect(res.status).toBe(422);
  });

  it("returns 500 for unexpected validation errors", async () => {
    vi.doMock("@/models", () => ({
      createProviderConnection: vi.fn(),
    }));
    vi.doMock("@/lib/oauth/services/kiro", () => ({
      KiroService: class {
        async validateApiKey() {
          throw new Error("Network unreachable");
        }
      },
    }));

    const { POST } = await import("@/app/api/oauth/kiro/api-key/route.js");
    const res = await POST(mockRequest());

    expect(res.status).toBe(500);
  });
});
