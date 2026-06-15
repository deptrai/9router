/**
 * In-place retry cho pre-content empty/malformed upstream (DefaultExecutor).
 *
 * Bối cảnh: relay provider (vuz, openai-compatible) trả HTTP 200 rồi phát
 * `event: error` "empty upstream response" TRƯỚC khi có content. Trước fix này
 * DefaultExecutor đổi thẳng 200→503 (bỏ account) — không thử lại cùng upstream.
 * Fix: retry IN-PLACE N lần (mặc định 2, theo retryConfig[503]) trước khi mới
 * escalate 503 cho account/combo fallback. SAFE vì chưa có byte content nào ra
 * client (ssePeek chỉ match pre-content error).
 *
 * Cô lập retry loop bằng cách spy BaseExecutor.prototype.execute (loop gọi
 * super.execute) và mock ssePeek — không cần dựng cả fetch chain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/ssePeek.js", () => ({
  peekStreamForEmptyUpstream: vi.fn(),
}));

import { peekStreamForEmptyUpstream } from "../../open-sse/utils/ssePeek.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";

// A 200 streaming response with a cancellable body (peek/loop may cancel it).
function ok200() {
  const body = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')); c.close(); },
  });
  return { ok: true, status: 200, statusText: "OK", headers: new Headers(), body };
}
function nonOk(status = 503) {
  return { ok: false, status, statusText: "Err", headers: new Headers(), body: null };
}

const baseArgs = { stream: true, model: "m", body: { messages: [] }, credentials: {}, log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } };

describe("DefaultExecutor — in-place retry on pre-content empty upstream", () => {
  let superSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    // Make setTimeout fire immediately so retry delays don't slow the test.
    vi.spyOn(global, "setTimeout").mockImplementation((fn) => { fn(); return 0; });
    superSpy = vi.spyOn(BaseExecutor.prototype, "execute");
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("empty on attempt 1 → healthy on attempt 2: re-executes and returns healthy stream", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    superSpy.mockResolvedValue({ response: ok200() });
    const replayed = ok200();
    peekStreamForEmptyUpstream
      .mockResolvedValueOnce({ matched: "empty upstream response", kind: "empty", response: ok200(), aborted: false })
      .mockResolvedValueOnce({ matched: null, kind: null, response: replayed, aborted: false });

    const result = await ex.execute({ ...baseArgs });

    expect(superSpy).toHaveBeenCalledTimes(2);
    expect(result.response).toBe(replayed);
    expect(result.response.status).toBe(200);
  });

  it("empty on every attempt (1 initial + 2 retries) → 503 empty_upstream_response", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    superSpy.mockResolvedValue({ response: ok200() });
    peekStreamForEmptyUpstream.mockResolvedValue({ matched: "empty upstream response", kind: "empty", response: ok200(), aborted: false });

    const result = await ex.execute({ ...baseArgs });

    expect(superSpy).toHaveBeenCalledTimes(3); // 1 + 2 retries (default retryConfig[503].attempts=2)
    expect(result.response.status).toBe(503);
    const body = JSON.parse(await result.response.text());
    expect(body.error.code).toBe("empty_upstream_response");
  });

  it("kind=overloaded is retried (not excluded)", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    superSpy.mockResolvedValue({ response: ok200() });
    peekStreamForEmptyUpstream
      .mockResolvedValueOnce({ matched: "overloaded", kind: "overloaded", response: ok200(), aborted: false })
      .mockResolvedValueOnce({ matched: null, kind: null, response: ok200(), aborted: false });

    const result = await ex.execute({ ...baseArgs });
    expect(superSpy).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
  });

  it("kind=error (generic) is retried", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    superSpy.mockResolvedValue({ response: ok200() });
    peekStreamForEmptyUpstream
      .mockResolvedValueOnce({ matched: "boom", kind: "error", response: ok200(), aborted: false })
      .mockResolvedValueOnce({ matched: null, kind: null, response: ok200(), aborted: false });

    const result = await ex.execute({ ...baseArgs });
    expect(superSpy).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
  });

  it("healthy stream on first peek → no retry, returns replayed body", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    superSpy.mockResolvedValue({ response: ok200() });
    const replayed = ok200();
    peekStreamForEmptyUpstream.mockResolvedValueOnce({ matched: null, kind: null, response: replayed, aborted: false });

    const result = await ex.execute({ ...baseArgs });
    expect(superSpy).toHaveBeenCalledTimes(1);
    expect(peekStreamForEmptyUpstream).toHaveBeenCalledTimes(1);
    expect(result.response).toBe(replayed);
  });

  it("non-relay provider (gemini) → never peeks, never retries", async () => {
    const ex = new DefaultExecutor("gemini");
    const original = ok200();
    superSpy.mockResolvedValue({ response: original });

    const result = await ex.execute({ ...baseArgs });
    expect(superSpy).toHaveBeenCalledTimes(1);
    expect(peekStreamForEmptyUpstream).not.toHaveBeenCalled();
    expect(result.response).toBe(original);
  });

  it("non-streaming request → never peeks", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    const original = ok200();
    superSpy.mockResolvedValue({ response: original });

    const result = await ex.execute({ ...baseArgs, stream: false });
    expect(superSpy).toHaveBeenCalledTimes(1);
    expect(peekStreamForEmptyUpstream).not.toHaveBeenCalled();
    expect(result.response).toBe(original);
  });

  it("non-ok upstream → returned as-is, not peeked", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    const err = nonOk(503);
    superSpy.mockResolvedValue({ response: err });

    const result = await ex.execute({ ...baseArgs });
    expect(peekStreamForEmptyUpstream).not.toHaveBeenCalled();
    expect(result.response).toBe(err);
  });

  it("client signal already aborted → throws AbortError, no upstream fetch", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    superSpy.mockResolvedValue({ response: ok200() });
    const args = { ...baseArgs, signal: { aborted: true } };

    // Already-cancelled client must NOT trigger a redundant super.execute fetch;
    // throw AbortError so chatCore maps it to 499.
    await expect(ex.execute(args)).rejects.toMatchObject({ name: "AbortError" });
    expect(superSpy).not.toHaveBeenCalled();
    expect(peekStreamForEmptyUpstream).not.toHaveBeenCalled();
  });

  it("peek aborted/timed out (signal not aborted) → 503 for fallback", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    superSpy.mockResolvedValue({ response: ok200() });
    peekStreamForEmptyUpstream.mockResolvedValueOnce({ matched: null, kind: null, response: null, aborted: true });

    const result = await ex.execute({ ...baseArgs });
    expect(result.response.status).toBe(503);
    const body = JSON.parse(await result.response.text());
    expect(body.error.code).toBe("empty_upstream_response");
  });

  it("attempts=0 override → single call → 503 (regression of pre-retry behavior)", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    ex.config = { ...ex.config, retry: { 503: { attempts: 0, delayMs: 0 } } };
    superSpy.mockResolvedValue({ response: ok200() });
    peekStreamForEmptyUpstream.mockResolvedValue({ matched: "empty upstream response", kind: "empty", response: ok200(), aborted: false });

    const result = await ex.execute({ ...baseArgs });
    expect(superSpy).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(503);
  });

  it("misconfigured attempts=Infinity → clamped, does NOT loop forever → single call → 503", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    ex.config = { ...ex.config, retry: { 503: { attempts: Infinity, delayMs: 0 } } };
    superSpy.mockResolvedValue({ response: ok200() });
    peekStreamForEmptyUpstream.mockResolvedValue({ matched: "empty upstream response", kind: "empty", response: ok200(), aborted: false });

    const result = await ex.execute({ ...baseArgs });
    // Infinity is clamped to 0 → no retry → single upstream call → escalate 503.
    expect(superSpy).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(503);
  });

  it("delays between retries (setTimeout invoked with configured delayMs)", async () => {
    const ex = new DefaultExecutor("openai-compatible-test");
    superSpy.mockResolvedValue({ response: ok200() });
    peekStreamForEmptyUpstream
      .mockResolvedValueOnce({ matched: "empty upstream response", kind: "empty", response: ok200(), aborted: false })
      .mockResolvedValueOnce({ matched: null, kind: null, response: ok200(), aborted: false });

    await ex.execute({ ...baseArgs });
    expect(global.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1000); // DEFAULT_RETRY_CONFIG[503].delayMs
  });
});
