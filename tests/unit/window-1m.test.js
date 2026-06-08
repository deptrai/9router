import { describe, it, expect } from "vitest";
import { duration, resolveWindow, formatResetCountdown } from "@/lib/quota/window.js";

describe("window.js — 1m type (AC#1)", () => {
  it("duration('1m') === 60_000ms", () => {
    expect(duration("1m")).toBe(60_000);
  });

  it("resolveWindow(null, '1m', t) → reset=true, startedAt=now", () => {
    const now = Date.now();
    const r = resolveWindow(null, "1m", now);
    expect(r.reset).toBe(true);
    expect(new Date(r.startedAt).getTime()).toBe(now);
  });

  it("resolveWindow({startedAt: t-30s}, '1m', t) → reset=false (still in window)", () => {
    const now = Date.now();
    const r = resolveWindow({ startedAt: new Date(now - 30_000).toISOString() }, "1m", now);
    expect(r.reset).toBe(false);
  });

  it("resolveWindow({startedAt: t-61s}, '1m', t) → reset=true (window expired)", () => {
    const now = Date.now();
    const r = resolveWindow({ startedAt: new Date(now - 61_000).toISOString() }, "1m", now);
    expect(r.reset).toBe(true);
  });

  it("resolveWindow({startedAt: t-60s exactly}, '1m', t) → reset=true (boundary: >=)", () => {
    const now = Date.now();
    const r = resolveWindow({ startedAt: new Date(now - 60_000).toISOString() }, "1m", now);
    expect(r.reset).toBe(true);
  });

  it("5h window still works correctly (regression)", () => {
    const now = Date.now();
    expect(duration("5h")).toBe(5 * 3600 * 1000);
    const r1 = resolveWindow(null, "5h", now);
    expect(r1.reset).toBe(true);
    const r2 = resolveWindow({ startedAt: new Date(now - 1000).toISOString() }, "5h", now);
    expect(r2.reset).toBe(false);
  });

  it("weekly window still works correctly (regression)", () => {
    const now = Date.now();
    expect(duration("weekly")).toBe(7 * 24 * 3600 * 1000);
    const r = resolveWindow({ startedAt: new Date(now - 1000).toISOString() }, "weekly", now);
    expect(r.reset).toBe(false);
  });

  it("unknown type throws", () => {
    expect(() => duration("bad")).toThrow("Unknown window type: bad");
  });
});
