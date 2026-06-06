// Story 2.6 Task 1: sendEmail unit tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  // Reset env
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  global.fetch = undefined;
});

afterEach(() => {
  // Restore env
  Object.keys(originalEnv).forEach(k => { process.env[k] = originalEnv[k]; });
  vi.restoreAllMocks();
});

describe("sendEmail", () => {
  it("missing RESEND_API_KEY → skipped (no fetch call)", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Test</p>" });

    expect(result.sent).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing EMAIL_FROM → skipped (no fetch call)", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Test</p>" });

    expect(result.sent).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

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
    expect(global.fetch).toHaveBeenCalledOnce();

    // Verify correct request structure
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(opts.body);
    expect(body.from).toBe("noreply@9router.dev");
    expect(body.to).toBe("user@example.com");
    expect(body.subject).toBe("Verify");
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
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("422");
  });

  it("Network error → { sent:false, error } (no throw)", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "noreply@9router.dev";

    global.fetch = vi.fn().mockRejectedValue(new Error("Network unreachable"));

    const { sendEmail } = await import("@/lib/email/sendEmail.js");
    const result = await sendEmail({ to: "user@example.com", subject: "Test", html: "<p>x</p>" });

    expect(result.sent).toBe(false);
    expect(result.error).toContain("Network unreachable");
  });
});
