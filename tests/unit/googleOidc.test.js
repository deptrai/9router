import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { jwtVerifyMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => "mock-jwks"),
  jwtVerify: jwtVerifyMock,
}));

const origClientId = process.env.GOOGLE_CLIENT_ID;
const origClientSecret = process.env.GOOGLE_CLIENT_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
});

afterEach(() => {
  if (origClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = origClientId;
  if (origClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = origClientSecret;
});

describe("isGoogleConfigured", () => {
  it("true when both env vars set", async () => {
    const { isGoogleConfigured } = await import("@/lib/auth/googleOidc.js");
    expect(isGoogleConfigured()).toBe(true);
  });

  it("false when GOOGLE_CLIENT_ID missing", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const { isGoogleConfigured } = await import("@/lib/auth/googleOidc.js");
    expect(isGoogleConfigured()).toBe(false);
  });

  it("false when GOOGLE_CLIENT_SECRET missing", async () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    const { isGoogleConfigured } = await import("@/lib/auth/googleOidc.js");
    expect(isGoogleConfigured()).toBe(false);
  });
});

describe("verifyGoogleIdToken", () => {
  it("valid token → returns sub, email, name", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "google-sub-123",
        email: "user@example.com",
        name: "Test User",
        email_verified: true,
        nonce: "test-nonce",
        exp: 1750000000000,
      },
    });

    const { verifyGoogleIdToken } = await import("@/lib/auth/googleOidc.js");
    const result = await verifyGoogleIdToken("fake.id.token", "test-nonce");
    expect(result.sub).toBe("google-sub-123");
    expect(result.email).toBe("user@example.com");
    expect(result.name).toBe("Test User");
  });

  it("email_verified = false → throws", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "google-sub-456",
        email: "unverified@example.com",
        email_verified: false,
        nonce: "test-nonce",
        exp: 1750000000000,
      },
    });

    const { verifyGoogleIdToken } = await import("@/lib/auth/googleOidc.js");
    await expect(verifyGoogleIdToken("fake.id.token", "test-nonce")).rejects.toThrow("email not verified");
  });

  it("jwtVerify throws (e.g. expired) → propagates", async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error("token expired"));

    const { verifyGoogleIdToken } = await import("@/lib/auth/googleOidc.js");
    await expect(verifyGoogleIdToken("expired.token", "nonce")).rejects.toThrow("token expired");
  });
});
