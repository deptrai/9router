/**
 * Story 1.6 guardrail — accountFallback.js edge cases
 * Covers: checkFallbackError text rules, status rules, isModelLockActive,
 *         formatRetryAfter, getQuotaCooldown boundary at level 0.
 */
import { describe, it, expect } from "vitest";
import {
  checkFallbackError,
  getQuotaCooldown,
  isModelLockActive,
  formatRetryAfter,
  isAccountUnavailable,
  getEarliestModelLockUntil,
  buildModelLockUpdate,
  isRequestShapeError,
} from "../../open-sse/services/accountFallback.js";
import { normalizeUnavailableStatus, parseUpstreamError } from "../../open-sse/utils/error.js";

// ---------------------------------------------------------------------------
// getQuotaCooldown — level 0 boundary (Patch B: base = 8000)
// ---------------------------------------------------------------------------
describe("getQuotaCooldown — Patch B boundaries", () => {
  it("level 0 returns base (8000ms) — not 0, not 4000", () => {
    expect(getQuotaCooldown(0)).toBe(8000);
  });

  it("level 1 returns base (8000ms)", () => {
    expect(getQuotaCooldown(1)).toBe(8000);
  });

  it("level 2 doubles to 16000ms", () => {
    expect(getQuotaCooldown(2)).toBe(16000);
  });

  it("high level is capped at 10 minutes", () => {
    expect(getQuotaCooldown(100)).toBe(10 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// checkFallbackError — text-based rules
// ---------------------------------------------------------------------------
describe("checkFallbackError — text rules (case-insensitive)", () => {
  it("'rate limit' text triggers backoff fallback", () => {
    const result = checkFallbackError(200, "rate limit exceeded for model");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThanOrEqual(8000);
  });

  it("'too many requests' text triggers backoff fallback", () => {
    const result = checkFallbackError(200, "Too Many Requests from upstream");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThanOrEqual(8000);
  });

  it("'quota exceeded' text triggers backoff fallback", () => {
    const result = checkFallbackError(200, "Quota Exceeded for this account");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThanOrEqual(8000);
  });

  it("'capacity' text triggers backoff fallback", () => {
    const result = checkFallbackError(200, "over capacity, please try again");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThanOrEqual(8000);
  });

  it("'overloaded' text triggers backoff fallback", () => {
    const result = checkFallbackError(200, "Server overloaded");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThanOrEqual(8000);
  });

  it("'no credentials' text triggers long cooldown (not backoff)", () => {
    const result = checkFallbackError(200, "no credentials available");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(2 * 60 * 1000);
    expect(result.newBackoffLevel).toBeUndefined();
  });

  it("'request not allowed' text triggers short cooldown", () => {
    const result = checkFallbackError(200, "request not allowed by policy");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(5 * 1000);
  });

  it("Kiro content-length threshold is context overflow, not account fallback", () => {
    const result = checkFallbackError(
      400,
      '{"message":"Input is too long.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}'
    );

    expect(result).toMatchObject({
      shouldFallback: false,
      cooldownMs: 0,
      reason: "context_window_exceeded",
    });
  });

  it("plain 'Input is too long' is context overflow, not account fallback", () => {
    const result = checkFallbackError(400, "Input is too long.");
    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("Kiro 'Improperly formed request' is request-shape, not account cooldown", () => {
    const result = checkFallbackError(400, "Improperly formed request.");

    expect(isRequestShapeError("Improperly formed request.")).toBe(true);
    expect(result).toMatchObject({
      shouldFallback: false,
      cooldownMs: 0,
      reason: "request_shape_error",
    });
  });
});

describe("normalizeUnavailableStatus — all-locked provider state", () => {
  it("does not leak stale upstream 400 as an unavailable response status", () => {
    expect(normalizeUnavailableStatus(400)).toBe(503);
  });

  it("preserves retryable rate-limit and gateway statuses", () => {
    expect(normalizeUnavailableStatus(429)).toBe(429);
    expect(normalizeUnavailableStatus(502)).toBe(502);
    expect(normalizeUnavailableStatus(503)).toBe(503);
    expect(normalizeUnavailableStatus(504)).toBe(504);
  });
});

describe("parseUpstreamError — Kiro structured 400", () => {
  it("preserves CONTENT_LENGTH_EXCEEDS_THRESHOLD reason when executor echoes raw JSON", async () => {
    const response = new Response(JSON.stringify({
      message: "Input is too long.",
      reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
    }), { status: 400, headers: { "Content-Type": "application/json" } });
    const executor = {
      parseError(res, bodyText) {
        return { status: res.status, message: bodyText };
      },
    };

    const parsed = await parseUpstreamError(response, executor);

    expect(parsed).toMatchObject({
      statusCode: 400,
      reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
    });
    expect(parsed.message).toContain("Input is too long.");
    expect(parsed.message).toContain("CONTENT_LENGTH_EXCEEDS_THRESHOLD");
  });
});

// ---------------------------------------------------------------------------
// checkFallbackError — status-based rules (no matching text)
// ---------------------------------------------------------------------------
describe("checkFallbackError — status-only rules", () => {
  it("status 429 with no text triggers backoff fallback", () => {
    const result = checkFallbackError(429, "");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThanOrEqual(8000);
    expect(result.newBackoffLevel).toBe(1);
  });

  it("status 429 increments backoffLevel", () => {
    const r0 = checkFallbackError(429, "", 0);
    const r2 = checkFallbackError(429, "", 2);
    expect(r0.newBackoffLevel).toBe(1);
    expect(r2.newBackoffLevel).toBe(3);
    expect(r2.cooldownMs).toBe(32000);
  });

  it("status 401 triggers long cooldown", () => {
    const result = checkFallbackError(401, "");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(2 * 60 * 1000);
  });

  it("status 403 triggers long cooldown", () => {
    const result = checkFallbackError(403, "");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(2 * 60 * 1000);
  });

  it("status 404 triggers long cooldown", () => {
    const result = checkFallbackError(404, "");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(2 * 60 * 1000);
  });

  it("text rule takes priority over status rule", () => {
    // 'rate limit' text matches before status 429 status rule
    const byText = checkFallbackError(429, "rate limit exceeded", 0);
    const byStatus = checkFallbackError(429, "", 0);
    // Both trigger backoff, text rule fires first but result is same type
    expect(byText.shouldFallback).toBe(true);
    expect(byStatus.shouldFallback).toBe(true);
    expect(byText.newBackoffLevel).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isModelLockActive — various model lock states
// ---------------------------------------------------------------------------
describe("isModelLockActive — lock expiry checks", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();

  it("active model lock returns true", () => {
    const conn = { "modelLock_kiro/auto": future };
    expect(isModelLockActive(conn, "kiro/auto")).toBe(true);
  });

  it("expired model lock returns false", () => {
    const conn = { "modelLock_kiro/auto": past };
    expect(isModelLockActive(conn, "kiro/auto")).toBe(false);
  });

  it("no lock for model returns false", () => {
    const conn = {};
    expect(isModelLockActive(conn, "kiro/auto")).toBe(false);
  });

  it("__all (account-level) lock covers any model", () => {
    const conn = { "modelLock___all": future };
    expect(isModelLockActive(conn, "kiro/auto")).toBe(true);
    expect(isModelLockActive(conn, "kiro/sonnet")).toBe(true);
  });

  it("__all lock takes priority even when model-specific lock absent", () => {
    const conn = { "modelLock___all": future };
    expect(isModelLockActive(conn, null)).toBe(true);
  });

  it("null model checks __all key", () => {
    const conn = { "modelLock___all": future };
    expect(isModelLockActive(conn, null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatRetryAfter — human-readable output
// ---------------------------------------------------------------------------
describe("formatRetryAfter", () => {
  it("null/empty → empty string", () => {
    expect(formatRetryAfter(null)).toBe("");
    expect(formatRetryAfter(undefined)).toBe("");
  });

  it("past timestamp → 'reset after 0s'", () => {
    const past = new Date(Date.now() - 5000).toISOString();
    expect(formatRetryAfter(past)).toBe("reset after 0s");
  });

  it("~30s → 'reset after 30s'", () => {
    const soon = new Date(Date.now() + 29_500).toISOString();
    const result = formatRetryAfter(soon);
    expect(result).toMatch(/reset after \d+s/);
    expect(result).not.toContain("m");
  });

  it("~90s → 'reset after 1m 30s'", () => {
    const soon = new Date(Date.now() + 90_000).toISOString();
    const result = formatRetryAfter(soon);
    expect(result).toContain("1m");
    expect(result).toContain("s");
  });

  it("~1h → contains 'h'", () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    expect(formatRetryAfter(soon)).toContain("h");
  });
});

// ---------------------------------------------------------------------------
// isAccountUnavailable
// ---------------------------------------------------------------------------
describe("isAccountUnavailable", () => {
  it("null → false (no cooldown)", () => {
    expect(isAccountUnavailable(null)).toBe(false);
    expect(isAccountUnavailable(undefined)).toBe(false);
  });

  it("past timestamp → false (expired)", () => {
    expect(isAccountUnavailable(new Date(Date.now() - 1000).toISOString())).toBe(false);
  });

  it("future timestamp → true (still locked)", () => {
    expect(isAccountUnavailable(new Date(Date.now() + 60_000).toISOString())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getEarliestModelLockUntil + buildModelLockUpdate
// ---------------------------------------------------------------------------
describe("getEarliestModelLockUntil", () => {
  it("returns null for connection with no locks", () => {
    expect(getEarliestModelLockUntil({ id: "x", name: "test" })).toBeNull();
  });

  it("returns null when all locks are expired", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const conn = { "modelLock_kiro/auto": past };
    expect(getEarliestModelLockUntil(conn)).toBeNull();
  });

  it("returns earliest among multiple active locks", () => {
    const t1 = new Date(Date.now() + 10_000).toISOString();
    const t2 = new Date(Date.now() + 30_000).toISOString();
    const conn = { "modelLock_kiro/auto": t1, "modelLock_kiro/sonnet": t2 };
    const result = getEarliestModelLockUntil(conn);
    expect(new Date(result).getTime()).toBe(new Date(t1).getTime());
  });
});

describe("buildModelLockUpdate", () => {
  it("builds correct key for named model", () => {
    const update = buildModelLockUpdate("kiro/auto", 8000);
    expect(Object.keys(update)[0]).toBe("modelLock_kiro/auto");
    const expiry = new Date(Object.values(update)[0]).getTime();
    expect(expiry).toBeGreaterThan(Date.now() + 7000);
    expect(expiry).toBeLessThan(Date.now() + 9000);
  });

  it("builds __all key when model is null", () => {
    const update = buildModelLockUpdate(null, 8000);
    expect(Object.keys(update)[0]).toBe("modelLock___all");
  });
});
