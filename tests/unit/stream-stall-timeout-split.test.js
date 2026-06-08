import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStreamController,
  pipeWithDisconnect,
} from "open-sse/utils/streamHandler.js";
import {
  STREAM_STALL_TIMEOUT_MS,
  STREAM_TTFT_TIMEOUT_MS,
} from "open-sse/config/runtimeConfig.js";

const enc = new TextEncoder();

// Build a Response-like object whose body is a never-emitting ReadableStream —
// the source goes silent forever so the stall watchdog is the only thing that
// can end the stream.
function silentResponse() {
  return {
    body: new ReadableStream({
      // Never enqueue, never close.
      pull() { return new Promise(() => {}); },
    }),
  };
}

// Build a Response-like body that emits N chunks immediately then goes silent.
function partialResponse(chunks) {
  let i = 0;
  return {
    body: new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(enc.encode(chunks[i++]));
        }
        // After enqueuing all chunks: never close → silent gap.
      },
    }),
  };
}

// Identity transform — pass through what arrives.
function identityTransform() {
  return new TransformStream();
}

describe("config constants — stall/TTFT timeouts", () => {
  it("STREAM_TTFT_TIMEOUT_MS is 150s, longer than legacy 30s", () => {
    expect(STREAM_TTFT_TIMEOUT_MS).toBe(150_000);
  });
  it("STREAM_STALL_TIMEOUT_MS is 300s, below AWS NAT/NLB 350s hard limit", () => {
    expect(STREAM_STALL_TIMEOUT_MS).toBe(300_000);
    expect(STREAM_STALL_TIMEOUT_MS).toBeLessThan(350_000);
  });
  it("TTFT < stall — first byte budget is shorter than ongoing inter-chunk budget", () => {
    // Intentional: first-byte gets 150s, mid-stream gets 300s. Reasoning bursts
    // mid-stream are observed up to 100s, so 300s gives plenty of headroom.
    expect(STREAM_TTFT_TIMEOUT_MS).toBeLessThan(STREAM_STALL_TIMEOUT_MS);
  });
});

describe("pipeWithDisconnect — stall watchdog timing", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does NOT abort before TTFT_TIMEOUT_MS when no first byte arrives", async () => {
    const ctrl = createStreamController({ provider: "test", model: "m" });
    pipeWithDisconnect(silentResponse(), identityTransform(), ctrl);
    expect(ctrl.isConnected()).toBe(true);
    // Advance just under TTFT — must still be connected.
    await vi.advanceTimersByTimeAsync(STREAM_TTFT_TIMEOUT_MS - 1000);
    expect(ctrl.isConnected()).toBe(true);
  });

  it("aborts after TTFT_TIMEOUT_MS if first byte never arrives", async () => {
    const ctrl = createStreamController({ provider: "test", model: "m" });
    pipeWithDisconnect(silentResponse(), identityTransform(), ctrl);
    expect(ctrl.isConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(STREAM_TTFT_TIMEOUT_MS + 1000);
    // handleError set disconnected=true → isConnected returns false.
    expect(ctrl.isConnected()).toBe(false);
  });

  it("does NOT abort 30s into a healthy stream (legacy 30s would have killed thinking)", async () => {
    // The original bug: stall=30s killed Kiro thinking streams that paused
    // 40-100s mid-reasoning. A chunk that arrived first should re-arm the
    // watchdog with the inter-chunk budget (300s), not 30s.
    const ctrl = createStreamController({ provider: "test", model: "m" });
    const result = pipeWithDisconnect(partialResponse(["hello"]), identityTransform(), ctrl);
    // Pull one chunk so chunkCount goes 0→1 — armStall then uses the inter-chunk
    // budget (STREAM_STALL_TIMEOUT_MS) for re-arms instead of the TTFT budget.
    const reader = result.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBeGreaterThan(0);

    // 30s into the inter-chunk gap: legacy code would have aborted here.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ctrl.isConnected()).toBe(true);
    // 100s into the inter-chunk gap (worst observed thinking gap): still alive.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(ctrl.isConnected()).toBe(true);
    // Past 300s inter-chunk budget: now stall fires.
    await vi.advanceTimersByTimeAsync(STREAM_STALL_TIMEOUT_MS + 1000);
    expect(ctrl.isConnected()).toBe(false);

    // Cleanup so the test exits without a dangling reader.
    await reader.cancel().catch(() => {});
  });
});
