/**
 * Logger B2 — strip ANSI khi không TTY (production → log sạch cho Loki/Grafana),
 * level theo NODE_ENV/LOG_LEVEL, warn() được bật lại.
 *
 * Logger đọc process.stdout.isTTY ở module-load → set isTTY + env trước khi import,
 * dùng vi.resetModules() để re-evaluate mỗi test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const origIsTTY = process.stdout.isTTY;
const origEnv = process.env.NODE_ENV;
const origLevel = process.env.LOG_LEVEL;
const origNoColor = process.env.NO_COLOR;

beforeEach(() => {
  vi.resetModules();
  delete process.env.LOG_LEVEL;
  delete process.env.NO_COLOR;
});

afterEach(() => {
  Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
  if (origEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = origEnv;
  if (origLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = origLevel;
  if (origNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = origNoColor;
  vi.restoreAllMocks();
});

function setTTY(val) {
  Object.defineProperty(process.stdout, "isTTY", { value: val, configurable: true });
}

describe("logger — ANSI stripping (B2)", () => {
  it("không TTY: strip ANSI khỏi message (log sạch cho Loki)", async () => {
    setTTY(false);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = await import("@/sse/utils/logger.js");
    log.info("AUTH", "\x1b[32mUsing kiro account: foo\x1b[0m");
    const out = spy.mock.calls[0][0];
    expect(out).not.toMatch(/\x1b\[/);
    expect(out).toContain("Using kiro account: foo");
  });

  it("không TTY: request() không còn escape code", async () => {
    setTTY(false);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = await import("@/sse/utils/logger.js");
    log.request("POST", "/v1/chat/completions");
    expect(spy.mock.calls[0][0]).not.toMatch(/\x1b\[/);
  });

  it("có TTY: giữ màu (local dev)", async () => {
    setTTY(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = await import("@/sse/utils/logger.js");
    log.request("GET", "/health");
    expect(spy.mock.calls[0][0]).toMatch(/\x1b\[36m/);
  });

  it("NO_COLOR=1 ngay cả khi TTY: vẫn strip", async () => {
    setTTY(true);
    process.env.NO_COLOR = "1";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = await import("@/sse/utils/logger.js");
    log.info("X", "\x1b[31mred\x1b[0m");
    expect(spy.mock.calls[0][0]).not.toMatch(/\x1b\[/);
  });
});

describe("logger — level resolution (B2)", () => {
  it("production: DEBUG bị nén (không log)", async () => {
    setTTY(false);
    process.env.NODE_ENV = "production";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = await import("@/sse/utils/logger.js");
    log.debug("X", "debug-msg");
    expect(spy).not.toHaveBeenCalled();
  });

  it("production: INFO vẫn log", async () => {
    setTTY(false);
    process.env.NODE_ENV = "production";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = await import("@/sse/utils/logger.js");
    log.info("X", "info-msg");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("LOG_LEVEL=ERROR override: INFO bị nén", async () => {
    setTTY(false);
    process.env.NODE_ENV = "production";
    process.env.LOG_LEVEL = "ERROR";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = await import("@/sse/utils/logger.js");
    log.info("X", "info");
    log.error("X", "err");
    expect(logSpy).not.toHaveBeenCalled(); // INFO bị nén
    expect(errSpy).toHaveBeenCalledOnce(); // chỉ error (routed to stderr)
  });

  it("dev (non-production): DEBUG log", async () => {
    setTTY(false);
    process.env.NODE_ENV = "development";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = await import("@/sse/utils/logger.js");
    log.debug("X", "dbg");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("warn() được bật lại (trước đây bị comment) — log qua console.warn", async () => {
    setTTY(false);
    process.env.NODE_ENV = "production";
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = await import("@/sse/utils/logger.js");
    log.warn("X", "warning-msg");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain("warning-msg");
  });
});
