import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const kvStore = new Map();

vi.mock("@/lib/db/helpers/kvStore", () => ({
  makeKv: (scope) => ({
    async get(key, fallback = null) {
      const fullKey = `${scope}:${key}`;
      if (!kvStore.has(fullKey)) return fallback;
      return JSON.parse(JSON.stringify(kvStore.get(fullKey)));
    },
    async set(key, value) {
      const fullKey = `${scope}:${key}`;
      kvStore.set(fullKey, JSON.parse(JSON.stringify(value)));
    },
  }),
}));

describe("rateLimit — sliding window limiter (Story 2.6)", () => {
  beforeEach(() => {
    kvStore.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("[P0] returns null when id is null, undefined, or empty", async () => {
    const { createRateLimiter } = await import("@/lib/auth/rateLimit.js");
    const limiter = createRateLimiter("test_scope", { max: 3 });

    expect(await limiter(null)).toBeNull();
    expect(await limiter("")).toBeNull();
    expect(await limiter(undefined)).toBeNull();
  });

  it("[P0] allows requests within limit (returns null)", async () => {
    const { createRateLimiter } = await import("@/lib/auth/rateLimit.js");
    const limiter = createRateLimiter("login", { max: 3, windowMs: 60_000 });

    expect(await limiter("user-1")).toBeNull();
    expect(await limiter("user-1")).toBeNull();
    expect(await limiter("user-1")).toBeNull();
  });

  it("[P0] returns retryAfter in seconds when limit is exceeded", async () => {
    const { createRateLimiter } = await import("@/lib/auth/rateLimit.js");
    const limiter = createRateLimiter("password_reset", { max: 2, windowMs: 60_000 });

    await limiter("target-id");
    await limiter("target-id");

    // 3rd attempt exceeds max: 2
    const retryAfter = await limiter("target-id");
    expect(typeof retryAfter).toBe("number");
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("[P0] resets quota after window passes", async () => {
    const { createRateLimiter } = await import("@/lib/auth/rateLimit.js");
    const limiter = createRateLimiter("api_call", { max: 2, windowMs: 60_000 });

    await limiter("client-a");
    await limiter("client-a");
    expect(await limiter("client-a")).not.toBeNull();

    // Advance system time past the 60s window
    vi.advanceTimersByTime(65_000);

    // Should now be permitted again
    expect(await limiter("client-a")).toBeNull();
  });

  it("[P1] maintains separate counts for distinct ids under same scope", async () => {
    const { createRateLimiter } = await import("@/lib/auth/rateLimit.js");
    const limiter = createRateLimiter("send_otp", { max: 1, windowMs: 30_000 });

    expect(await limiter("id-1")).toBeNull();
    expect(await limiter("id-1")).not.toBeNull();

    // id-2 is independent and must not be blocked
    expect(await limiter("id-2")).toBeNull();
  });
});
