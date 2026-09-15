import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("loginLimiter — progressive lockout & IP resolution (Story 2.6)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("[P0] initial state is unlocked", async () => {
    const { checkLock } = await import("@/lib/auth/loginLimiter.js");
    const status = checkLock("192.168.1.100");
    expect(status.locked).toBe(false);
  });

  it("[P0] decrements remaining attempts and locks out after 5 consecutive failures", async () => {
    const { checkLock, recordFail } = await import("@/lib/auth/loginLimiter.js");
    const ip = "10.0.0.1";

    expect(recordFail(ip).remainingBeforeLock).toBe(4);
    expect(recordFail(ip).remainingBeforeLock).toBe(3);
    expect(recordFail(ip).remainingBeforeLock).toBe(2);
    expect(recordFail(ip).remainingBeforeLock).toBe(1);
    expect(checkLock(ip).locked).toBe(false);

    // 5th failure triggers 30s lockout (step 0: 30,000ms)
    recordFail(ip);
    const lockStatus = checkLock(ip);
    expect(lockStatus.locked).toBe(true);
    expect(lockStatus.retryAfter).toBeGreaterThan(0);
    expect(lockStatus.retryAfter).toBeLessThanOrEqual(30);
  });

  it("[P0] unlocks after lockout duration elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));

    const { checkLock, recordFail } = await import("@/lib/auth/loginLimiter.js");
    const ip = "10.0.0.2";

    for (let i = 0; i < 5; i++) recordFail(ip);
    expect(checkLock(ip).locked).toBe(true);

    // Advance past the 30s lock duration
    vi.advanceTimersByTime(31_000);
    expect(checkLock(ip).locked).toBe(false);
  });

  it("[P0] recordSuccess resets failure count and clears any lockout", async () => {
    const { checkLock, recordFail, recordSuccess } = await import("@/lib/auth/loginLimiter.js");
    const ip = "10.0.0.3";

    for (let i = 0; i < 4; i++) recordFail(ip);
    recordSuccess(ip);

    // Count should be reset back to 5 remaining
    const nextFail = recordFail(ip);
    expect(nextFail.remainingBeforeLock).toBe(4);
  });

  it("[P1] getClientIp prioritizes x-real-ip over x-forwarded-for (R4-P1-2 spoofing guard)", async () => {
    const { getClientIp } = await import("@/lib/auth/loginLimiter.js");

    const reqWithBoth = {
      headers: new Headers({
        "x-real-ip": "203.0.113.195",
        "x-forwarded-for": "198.51.100.1, 192.0.2.1",
      }),
    };
    expect(getClientIp(reqWithBoth)).toBe("203.0.113.195");
  });

  it("[P1] getClientIp falls back to first x-forwarded-for IP or unknown", async () => {
    const { getClientIp } = await import("@/lib/auth/loginLimiter.js");

    const reqXff = {
      headers: new Headers({
        "x-forwarded-for": "198.51.100.22, 10.0.0.1",
      }),
    };
    expect(getClientIp(reqXff)).toBe("198.51.100.22");

    const reqEmpty = { headers: new Headers() };
    expect(getClientIp(reqEmpty)).toBe("unknown");
  });
});
