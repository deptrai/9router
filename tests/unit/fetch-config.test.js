import { describe, it, expect } from "vitest";

describe("runtimeConfig fetch connect timeout", () => {
  it("FETCH_CONNECT_TIMEOUT_MS = 30s (30000)", async () => {
    const mod = await import("../../open-sse/config/runtimeConfig.js");
    expect(mod.FETCH_CONNECT_TIMEOUT_MS).toBe(30 * 1000);
  });

  it("STREAM_STALL_TIMEOUT_MS >= 5 min", async () => {
    const mod = await import("../../open-sse/config/runtimeConfig.js");
    expect(mod.STREAM_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});

describe("DEFAULT_RETRY_CONFIG", () => {
  it("502 retry: 2 attempts, 1s delay", async () => {
    const mod = await import("../../open-sse/config/runtimeConfig.js");
    expect(mod.DEFAULT_RETRY_CONFIG[502]).toEqual({ attempts: 2, delayMs: 1000 });
  });

  it("503 retry: 2 attempts, 1s delay", async () => {
    const mod = await import("../../open-sse/config/runtimeConfig.js");
    expect(mod.DEFAULT_RETRY_CONFIG[503]).toEqual({ attempts: 2, delayMs: 1000 });
  });

  it("504 retry: 2 attempts, 1s delay", async () => {
    const mod = await import("../../open-sse/config/runtimeConfig.js");
    expect(mod.DEFAULT_RETRY_CONFIG[504]).toEqual({ attempts: 2, delayMs: 1000 });
  });

  it("429 retry: 0 attempts (no retry)", async () => {
    const mod = await import("../../open-sse/config/runtimeConfig.js");
    expect(mod.DEFAULT_RETRY_CONFIG[429]).toEqual({ attempts: 0, delayMs: 0 });
  });
});

describe("resolveRetryEntry", () => {
  it("returns { attempts: 0, delayMs } when entry is null", async () => {
    const mod = await import("../../open-sse/config/runtimeConfig.js");
    const result = mod.resolveRetryEntry(null);
    expect(result.attempts).toBe(0);
    expect(result.delayMs).toBeGreaterThan(0);
  });
});
