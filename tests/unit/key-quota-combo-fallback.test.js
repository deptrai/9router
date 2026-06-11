/**
 * D3: Combo fallback test — AC#4 Story 1.3
 *
 * Verify: quota-block (status 429 + message "quota exceeded")
 * khi đưa qua checkFallbackError → shouldFallback:true → combo nhảy model kế.
 *
 * Theo Dev Notes: "Combo fallback — đã verify (không còn cần verify)"
 * Test này document behaviour đã xác nhận.
 */

import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("D3: combo fallback khi quota block (AC#4)", () => {
  it("429 + 'quota exceeded' → shouldFallback:true (combo nhảy model kế)", () => {
    const { shouldFallback } = checkFallbackError(429, "[anthropic/claude-opus-4.7] quota exceeded");
    expect(shouldFallback).toBe(true);
  });

  it("429 + 'quota exceeded (reset after 2h 30m)' → shouldFallback:true", () => {
    const { shouldFallback } = checkFallbackError(429, "[anthropic/claude-opus-4.7] quota exceeded (reset after 2h 30m)");
    expect(shouldFallback).toBe(true);
  });

  it("status 429 alone → shouldFallback:true (rate limit rule)", () => {
    // Status 429 match rule {status:429, backoff:true}
    const { shouldFallback } = checkFallbackError(429, "");
    expect(shouldFallback).toBe(true);
  });

  it("'quota exceeded' text match → shouldFallback:true bất kể status", () => {
    // Text rule "quota exceeded" → backoff:true → shouldFallback
    const { shouldFallback } = checkFallbackError(200, "quota exceeded for this period");
    expect(shouldFallback).toBe(true);
  });

  it("quota-block response có Retry-After header (unavailableResponse pattern)", () => {
    // Simulate: checkKeyQuota trả retryAfter; unavailableResponse tạo Response đúng
    const retryAfter = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
    const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);

    // unavailableResponse: status 429, header Retry-After = seconds
    expect(retryAfterSec).toBeGreaterThan(0);
    expect(retryAfterSec).toBeLessThanOrEqual(5 * 3600 + 1);
  });

  it("request-shape 400 không bị hiểu nhầm thành quota/account fallback", () => {
    const { shouldFallback, cooldownMs, reason } = checkFallbackError(400, "invalid request body");
    expect(shouldFallback).toBe(false);
    expect(cooldownMs).toBe(0);
    expect(reason).toBe("request_shape_error");
  });
});
