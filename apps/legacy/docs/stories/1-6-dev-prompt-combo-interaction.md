# Dev Prompt — Story 1.6 Phần G: Combo-Interaction Tests (AC#9)

> **Context:** Story 1.6 (Kiro fallback optimization) đã code xong Patches A–E, 842 tests pass. Đây là follow-up thêm AC#9 + test combo-interaction để khoá hành vi: "khi model 429 trong combo, combo nhảy ngay sang model kế, KHÔNG chờ cooldown".

## Bối cảnh kỹ thuật (đọc kỹ trước khi viết test)

`open-sse/services/combo.js:150–170`:
```js
const { shouldFallback, cooldownMs } = checkFallbackError(result.status, errorText);
if (!shouldFallback) {
  log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
  return result;
}
// For transient errors (503/502/504), wait for cooldown before falling through
if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
    (result.status === 503 || result.status === 502 || result.status === 504)) {
  await new Promise(r => setTimeout(r, cooldownMs));
}
// Fallback to next model
```

Phân tích kết hợp với `errorConfig.js`:
- `checkFallbackError(429, "")` → match status:429 với `backoff:true` → `cooldownMs` từ `getQuotaCooldown(level+1)` = 8000ms (Patch B). **8000 > 5000** → wait branch KHÔNG fire → combo nhảy model kế ngay. ✅ Đây là điều AC#9 yêu cầu.
- `checkFallbackError(503, "")` (no text match) → fall-through default `TRANSIENT_COOLDOWN_MS = 30000`. **30000 > 5000** → wait branch CŨNG không fire. Tức là wait branch trong combo hiện tại là **gần như dead code** với input thực tế (chỉ active khi text-rule match cho `cooldownMs ≤ 5000`, vd "request not allowed" = `COOLDOWN.short = 5000`). Đây là behavior observation, KHÔNG phải mục tiêu fix của story này.

## Yêu cầu

Thêm 1 file test mới (gộp 3 test). Không sửa source code.

### File: `tests/unit/combo-fallback-429-no-wait.test.js`

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleComboChat } from "open-sse/services/combo.js";
import { checkFallbackError } from "open-sse/services/accountFallback.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

describe("combo fallback — AC#9: 429 falls through without waiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    log.info.mockClear(); log.warn.mockClear(); log.debug.mockClear();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("checkFallbackError(429) returns cooldownMs > 5000 — proves wait branch will NOT fire", () => {
    // Patch B: BACKOFF_CONFIG.base = 8000 → level 1 cooldown = 8000ms
    const { shouldFallback, cooldownMs } = checkFallbackError(429, "", 0);
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBeGreaterThan(5000);
    // combo.js wait branch requires cooldownMs <= 5000 → 429 cannot trigger wait
  });

  it("combo: model 1 returns 429 → model 2 is called WITHOUT setTimeout delay", async () => {
    const model1Response = new Response(
      JSON.stringify({ error: { message: "all kiro accounts rate-limited" } }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
    const model2Response = new Response(JSON.stringify({ ok: true }), { status: 200 });

    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(model1Response)
      .mockResolvedValueOnce(model2Response);

    // Spy on setTimeout to detect any wait
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

    // The combo's wait branch (await new Promise(r => setTimeout(r, cooldownMs)))
    // must NOT have been invoked for the 429. setTimeout calls from internal
    // scheduling (e.g. queue microtasks) may exist — assert no setTimeout was
    // called with a delay > 0 between the two handleSingleModel invocations.
    const significantWaits = setTimeoutSpy.mock.calls.filter(
      (call) => typeof call[1] === "number" && call[1] > 0
    );
    expect(significantWaits).toHaveLength(0);

    setTimeoutSpy.mockRestore();
  });

  it("combo: 429 on all models → returns 503 with combined error, no wait between attempts", async () => {
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

    // Per combo.js: when all models fail, returns 503 (or last status if not "no credentials")
    expect(result.status).toBe(429); // last lastStatus carried
    expect(handleSingleModel).toHaveBeenCalledTimes(2);

    const significantWaits = setTimeoutSpy.mock.calls.filter(
      (call) => typeof call[1] === "number" && call[1] > 0
    );
    expect(significantWaits).toHaveLength(0);

    setTimeoutSpy.mockRestore();
  });
});
```

### Verify

```bash
cd /Users/luisphan/Documents/9router/tests
NODE_PATH=/tmp/node_modules npm test -- unit/combo-fallback-429-no-wait.test.js
```
Expect: 3/3 pass.

Sau đó chạy full suite:
```bash
NODE_PATH=/tmp/node_modules npm test
```
Expect: ≥845 pass, 0 fail.

## Constraints

- Chỉ thêm 1 test file. KHÔNG sửa source.
- Test framework: vitest, chạy từ `tests/`, alias `@/` → `src/`.
- Mock `Response` cần `.clone().json()` (combo gọi clone trước khi đọc body — tham khảo `combo.js:133`).
- Test #3 expect `result.status === 429`: đọc `combo.js:179–197` để xác nhận khi tất cả models fail, code trả `lastStatus || 503`. Nếu thực tế trả 503 thay vì 429, đổi assertion theo behavior thật (đừng chỉnh code).

## Khi hoàn tất

1. Tick G2 (đã gộp G3/G5 vào file này) trong `docs/stories/1-6-kiro-fallback-optimization.md`. G1 đánh tick (đã verify trong dev prompt). G3/G4/G5/G6 — đánh tick với note "gộp vào G2 file; G4 (503 wait) verified as observation-only, không phải regression target vì wait branch hiện không fire cho 503 thường (TRANSIENT_COOLDOWN_MS=30000 > 5000)."
2. Thêm entry Change Log: `2026-06-09 | AC#9 combo-interaction tests (G1–G6 → 1 file 3 tests). Suite: XXX pass.`
3. Thêm `tests/unit/combo-fallback-429-no-wait.test.js` vào File List.
4. Status: giữ `review` (đã ở review từ trước).
