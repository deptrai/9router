/**
 * Turnstile verify helper (B1 pre-launch hardening).
 * Test các nhánh: disabled (no secret) → fail-open; missing token → reject;
 * valid → ok; invalid → reject; network error → fail-closed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const origSecret = process.env.TURNSTILE_SECRET_KEY;

beforeEach(() => {
  vi.resetModules();
  delete process.env.TURNSTILE_SECRET_KEY;
});

afterEach(() => {
  if (origSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = origSecret;
  vi.restoreAllMocks();
});

describe("verifyTurnstile", () => {
  it("disabled (no secret) → ok:true, không gọi fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { verifyTurnstile } = await import("@/lib/auth/turnstile.js");
    const r = await verifyTurnstile("any-token", "1.2.3.4");
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enabled + missing token → reject (không gọi Cloudflare)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { verifyTurnstile } = await import("@/lib/auth/turnstile.js");
    const r = await verifyTurnstile(undefined, "1.2.3.4");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing-captcha");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enabled + valid token → ok:true", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({ success: true }),
    });
    const { verifyTurnstile } = await import("@/lib/auth/turnstile.js");
    const r = await verifyTurnstile("good-token", "1.2.3.4");
    expect(r.ok).toBe(true);
  });

  it("enabled + invalid token → reject với error-codes", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    });
    const { verifyTurnstile } = await import("@/lib/auth/turnstile.js");
    const r = await verifyTurnstile("bad-token", "1.2.3.4");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid-input-response");
  });

  it("network error talking to Cloudflare → fail-closed (ok:false)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const { verifyTurnstile } = await import("@/lib/auth/turnstile.js");
    const r = await verifyTurnstile("token", "1.2.3.4");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("verify-unreachable");
  });

  it("isTurnstileEnabled phản ánh đúng presence của secret", async () => {
    const mod1 = await import("@/lib/auth/turnstile.js");
    expect(mod1.isTurnstileEnabled()).toBe(false);
    process.env.TURNSTILE_SECRET_KEY = "secret";
    expect(mod1.isTurnstileEnabled()).toBe(true);
  });

  it("gửi đúng payload tới siteverify (secret + response + remoteip)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "my-secret";
    let capturedBody;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
      capturedBody = opts.body;
      return { json: async () => ({ success: true }) };
    });
    const { verifyTurnstile } = await import("@/lib/auth/turnstile.js");
    await verifyTurnstile("tok-123", "9.8.7.6");
    const params = new URLSearchParams(capturedBody);
    expect(params.get("secret")).toBe("my-secret");
    expect(params.get("response")).toBe("tok-123");
    expect(params.get("remoteip")).toBe("9.8.7.6");
  });
});
