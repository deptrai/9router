/**
 * C7 — ssePeek reader lock release (commit bd3f8db).
 *
 * Trước fix: pull() trong replacementBody chỉ gọi reader.cancel() ở path cancel(),
 * còn EOF và error path không releaseLock() → reader bị giữ mãi trên upstream body.
 * Sau fix: cả EOF (done=true) lẫn error path đều gọi upstreamReader.releaseLock().
 *
 * Kiểm chứng: sau khi drain hết replayed body, upstream.body.locked === false.
 */
import { describe, it, expect } from "vitest";
import { peekStreamForEmptyUpstream } from "open-sse/utils/ssePeek.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function healthyResponse(chunks) {
  const body = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function drainFully(response) {
  const reader = response.body.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

const HEALTHY_CHUNKS = [
  `data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
  `data: [DONE]\n\n`,
];

describe("C7 — ssePeek releaseLock on EOF", () => {
  it("upstream body not locked after draining replayed healthy stream (EOF path)", async () => {
    const upstream = healthyResponse(HEALTHY_CHUNKS);
    const { matched, response } = await peekStreamForEmptyUpstream(upstream);
    expect(matched).toBeNull(); // stream lành — không bị flag

    // Drain hết replayed body → pull() chạy đến done=true → releaseLock() gọi
    await drainFully(response);

    // Lock phải được giải phóng
    expect(upstream.body.locked).toBe(false);
  });

  it("replayed body vẫn trả đủ bytes sau EOF (không mất dữ liệu)", async () => {
    const upstream = healthyResponse(HEALTHY_CHUNKS);
    const { response } = await peekStreamForEmptyUpstream(upstream);
    const out = await drainFully(response);
    expect(out).toContain('"hello"');
    expect(out).toContain("[DONE]");
  });

  it("consumer cancel không throw và upstream stream bị cancel (cancel path)", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(HEALTHY_CHUNKS[0]));
      },
      cancel() { cancelled = true; },
    });
    const upstream = new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const { response } = await peekStreamForEmptyUpstream(upstream);
    // Cancel consumer → cancel handler gọi upstreamReader.cancel() → upstream stream cancelled
    await expect(response.body.cancel()).resolves.not.toThrow();
    expect(cancelled).toBe(true);
  });
});

describe("C7 — ssePeek releaseLock on error", () => {
  it("upstream body không locked sau khi pull() gặp error từ upstream", async () => {
    // Stream phát content trước (không bị flag là empty), rồi lỗi sau
    let upstreamController;
    const rawBody = new ReadableStream({
      start(c) {
        upstreamController = c;
        // Phát 1 content chunk — qua peek peek phase
        c.enqueue(enc.encode(
          `data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n`
        ));
      },
    });
    const upstream = new Response(rawBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const { matched, response } = await peekStreamForEmptyUpstream(upstream);
    expect(matched).toBeNull(); // content trước error → không flag

    // Bắt đầu đọc replayed body rồi inject error từ upstream
    const reader = response.body.getReader();
    // Đọc chunk đầu (đã buffer trong peek)
    await reader.read();

    // Inject lỗi vào upstream — pull() tiếp theo sẽ throw
    upstreamController.error(new Error("upstream exploded"));

    // Đọc đến khi error
    let threw = false;
    try {
      for (let i = 0; i < 5; i++) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Sau error path, releaseLock() phải được gọi
    expect(upstream.body.locked).toBe(false);
  });
});
