import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleComboChat } from "open-sse/services/combo.js";
import { checkFallbackError } from "open-sse/services/accountFallback.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

describe("combo fallback — AC#9: 429 falls through without waiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    log.info.mockClear();
    log.warn.mockClear();
    log.debug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checkFallbackError(429) returns cooldownMs > 5000 — proves wait branch will NOT fire", () => {
    const { shouldFallback, cooldownMs } = checkFallbackError(429, "", 0);
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBeGreaterThan(5000);
  });

  it("combo: model 1 returns 429 → model 2 is called without a wait", async () => {
    const model1Response = new Response(
      JSON.stringify({ error: { message: "all kiro accounts rate-limited" } }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
    const model2Response = new Response(JSON.stringify({ ok: true }), { status: 200 });

    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(model1Response)
      .mockResolvedValueOnce(model2Response);

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockClear();

    const result = await handleComboChat({
      body: { model: "kiro-auto-safe", messages: [{ role: "user", content: "hi" }] },
      models: ["kiro/auto", "codex/gpt-5.5"],
      handleSingleModel,
      log,
    });

    expect(result.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel.mock.calls[0][1]).toBe("kiro/auto");
    expect(handleSingleModel.mock.calls[1][1]).toBe("codex/gpt-5.5");

    const significantWaits = setTimeoutSpy.mock.calls.filter(
      (call) => typeof call[1] === "number" && call[1] > 0
    );
    expect(significantWaits).toHaveLength(0);

    setTimeoutSpy.mockRestore();
  });

  it("combo: 429 on all models returns last status without waiting between attempts", async () => {
    const r429 = (msg) => new Response(
      JSON.stringify({ error: { message: msg } }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );

    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(r429("kiro rate-limited"))
      .mockResolvedValueOnce(r429("codex rate-limited"));

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockClear();

    const result = await handleComboChat({
      body: { model: "kiro-auto-safe", messages: [] },
      models: ["kiro/auto", "codex/gpt-5.5"],
      handleSingleModel,
      log,
    });

    expect(result.status).toBe(429);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);

    const significantWaits = setTimeoutSpy.mock.calls.filter(
      (call) => typeof call[1] === "number" && call[1] > 0
    );
    expect(significantWaits).toHaveLength(0);

    setTimeoutSpy.mockRestore();
  });
});
