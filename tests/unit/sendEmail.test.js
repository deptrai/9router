// Story 2.6 Task 1: sendEmail unit tests (Resend + Mailpit adapters)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.MAILPIT_URL;
  global.fetch = undefined;
});

afterEach(() => {
  Object.keys(originalEnv).forEach(k => { process.env[k] = originalEnv[k]; });
  vi.restoreAllMocks();
});

describe("sendEmail — no provider", () => {
  it("neither MAILPIT_URL nor RESEND_API_KEY → skipped (no fetch call)", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Test</p>" });

    expect(result.sent).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sendEmail — Resend adapter", () => {
  it("Resend OK (2xx) → { sent:true }", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "noreply@9router.dev";

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "email-123" }),
    });

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    const result = await sendEmail({ to: "user@example.com", subject: "Verify", html: "<p>Click</p>" });

    expect(result.sent).toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(opts.headers.Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(opts.body);
    expect(body.from).toBe("noreply@9router.dev");
    expect(body.to).toBe("user@example.com");
  });

  it("Resend 4xx → { sent:false, error } (no throw)", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "noreply@9router.dev";

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: "Invalid email" }),
    });

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    const result = await sendEmail({ to: "bad@example.com", subject: "Test", html: "<p>x</p>" });

    expect(result.sent).toBe(false);
    expect(result.error).toContain("422");
  });

  it("Resend network error → { sent:false, error } (no throw)", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "noreply@9router.dev";

    global.fetch = vi.fn().mockRejectedValue(new Error("Network unreachable"));

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    const result = await sendEmail({ to: "user@example.com", subject: "Test", html: "<p>x</p>" });

    expect(result.sent).toBe(false);
    expect(result.error).toContain("Network unreachable");
  });
});

describe("sendEmail — Mailpit adapter", () => {
  it("Mailpit OK → { sent:true }, to is array in body", async () => {
    process.env.MAILPIT_URL = "http://localhost:8025";
    process.env.EMAIL_FROM = "9Router <noreply@localhost>";

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ID: "mp-abc123" }),
    });

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    const result = await sendEmail({ to: "user@example.com", subject: "Test", html: "<p>Hi</p>" });

    expect(result.sent).toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:8025/api/v1/send");
    const body = JSON.parse(opts.body);
    expect(Array.isArray(body.to)).toBe(true);
    expect(body.to).toContain("user@example.com");
    expect(body.subject).toBe("Test");
  });

  it("Mailpit takes priority over Resend when both set", async () => {
    process.env.MAILPIT_URL = "http://localhost:8025";
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "noreply@9router.dev";

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ID: "mp-priority" }),
    });

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    const result = await sendEmail({ to: "user@example.com", subject: "Test", html: "<p>x</p>" });

    expect(result.sent).toBe(true);
    const [url] = global.fetch.mock.calls[0];
    // Should use Mailpit, not Resend
    expect(url).toContain("localhost:8025");
    expect(url).not.toContain("resend.com");
  });

  it("Mailpit error → { sent:false, error } (no throw)", async () => {
    process.env.MAILPIT_URL = "http://localhost:8025";

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal" }),
    });

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    const result = await sendEmail({ to: "user@example.com", subject: "Test", html: "<p>x</p>" });

    expect(result.sent).toBe(false);
    expect(result.error).toContain("500");
  });

  it("Mailpit uses default from when EMAIL_FROM not set", async () => {
    process.env.MAILPIT_URL = "http://localhost:8025";
    // EMAIL_FROM intentionally not set

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ID: "mp-default" }),
    });

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    await sendEmail({ to: "user@example.com", subject: "Test", html: "<p>x</p>" });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.from).toBe("9Router <noreply@localhost>"); // default
  });
});
