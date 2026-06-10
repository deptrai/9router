import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const origClientId = process.env.GOOGLE_CLIENT_ID;
const origClientSecret = process.env.GOOGLE_CLIENT_SECRET;

beforeEach(() => {
  vi.resetModules();
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
});

afterEach(() => {
  if (origClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = origClientId;
  if (origClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = origClientSecret;
});

async function importWithMockJwt(jwtVerifyImpl) {
  vi.doMock("jose", () => ({
    createRemoteJWKSet: vi.fn(() => "mock-jwks"),
    jwtVerify: vi.fn(jwtVerifyImpl),
  }));
  return import("@/lib/auth/googleOidc.js");
}

describe("isGoogleConfigured", () => {
  it("true when both env vars set", async () => {
    const { isGoogleConfigured } = await importWithMockJwt(() => {});
    expect(isGoogleConfigured()).toBe(true);
  });

  it("false when GOOGLE_CLIENT_ID missing", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const { isGoogleConfigured } = await importWithMockJwt(() => {});
    expect(isGoogleConfigured()).toBe(false);
  });

  it("false when GOOGLE_CLIENT_SECRET missing", async () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    const { isGoogleConfigured } = await importWithMockJwt(() => {});
    expect(isGoogleConfigured()).toBe(false);
  });
});

describe("verifyGoogleIdToken", () => {
  it("valid token → returns sub, email, name", async () => {
    const { verifyGoogleIdToken } = await importWithMockJwt(() => ({
      payload: {
        sub: "google-sub-123",
        email: "user@example.com",
        name: "Test User",
        email_verified: true,
        nonce: "test-nonce",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    }));
    const result = await verifyGoogleIdToken("fake.id.token", "test-nonce");
    expect(result.sub).toBe("google-sub-123");
    expect(result.email).toBe("user@example.com");
    expect(result.name).toBe("Test User");
  });

  it("email_verified = false → throws", async () => {
    const { verifyGoogleIdToken } = await importWithMockJwt(() => ({
      payload: {
        sub: "google-sub-456",
        email: "unverified@example.com",
        email_verified: false,
        nonce: "test-nonce",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    }));
    await expect(verifyGoogleIdToken("fake.id.token", "test-nonce")).rejects.toThrow("email not verified");
  });

  it("jwtVerify throws (e.g. expired) → propagates", async () => {
    const { verifyGoogleIdToken } = await importWithMockJwt(() => {
      throw new Error("token expired");
    });
    await expect(verifyGoogleIdToken("expired.token", "nonce")).rejects.toThrow("token expired");
  });
});
