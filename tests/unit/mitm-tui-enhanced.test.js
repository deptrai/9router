/**
 * Story 2.1 — Enhanced TUI unit tests.
 *
 * Test các logic thuần (pure logic) có thể import mà không trigger module-level
 * side effects crash:
 * - AC3: validateConfigValue (URL/apiKey/boolean validation)
 * - AC4: colors.js (ANSI codes, TTY guard, colorByLevel, statusColor)
 * - AC5: password.js (env var fallback, file fallback, mode 0o600 check)
 *
 * AC1 (live logs panel) và AC2 (stats) cần integration test (server process +
 * TTY) — không cover trong unit test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const colors = require("../../mitm-client/src/ui/colors.js");
const { validateConfigValue } = require("../../mitm-client/src/ui/cli.js");
const passwordMod = require("../../mitm-client/src/ui/password.js");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── AC3: Config validation ────────────────────────────────────

describe("AC3 — validateConfigValue", () => {
  describe("routerUrl", () => {
    it("chấp nhận http URL hợp lệ", () => {
      expect(validateConfigValue("routerUrl", "http://localhost:20128").ok).toBe(true);
    });

    it("chấp nhận https URL hợp lệ", () => {
      expect(validateConfigValue("routerUrl", "https://9router.example.com").ok).toBe(true);
    });

    it("từ chối URL không hợp lệ (không protocol)", () => {
      const r = validateConfigValue("routerUrl", "invalid");
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Invalid URL/);
    });

    it("từ chối protocol không phải http/https (ftp)", () => {
      const r = validateConfigValue("routerUrl", "ftp://example.com");
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/protocol/);
    });

    it("từ chối empty string", () => {
      const r = validateConfigValue("routerUrl", "");
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/empty/);
    });
  });

  describe("apiKey", () => {
    it("chấp nhận non-empty string", () => {
      expect(validateConfigValue("apiKey", "sk-abc123").ok).toBe(true);
    });

    it("từ chối empty string", () => {
      const r = validateConfigValue("apiKey", "");
      expect(r.ok).toBe(false);
    });

    it("từ chối whitespace-only string", () => {
      const r = validateConfigValue("apiKey", "   ");
      expect(r.ok).toBe(false);
    });
  });

  describe("mitmDebug / certTrusted (boolean toggle)", () => {
    it("mitmDebug luôn ok (toggle, không cần validate value)", () => {
      expect(validateConfigValue("mitmDebug", true).ok).toBe(true);
      expect(validateConfigValue("mitmDebug", false).ok).toBe(true);
    });

    it("certTrusted luôn ok (toggle)", () => {
      expect(validateConfigValue("certTrusted", true).ok).toBe(true);
    });
  });

  it("từ chối key không xác định", () => {
    const r = validateConfigValue("unknownKey", "value");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown config key/);
  });
});

// ── AC4: Color coding ─────────────────────────────────────────

describe("AC4 — colors.js", () => {
  const origIsTTY = process.stdout.isTTY;
  const origNoColor = process.env.NO_COLOR;

  afterEach(() => {
    // Restore original state.
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true });
    if (origNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = origNoColor;
  });

  it("trả plain text (không ANSI) khi non-TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    // Re-require to pick up new TTY state — colors.js caches HAS_COLOR at load.
    // Thay vì re-require, test trực tiếp wrap function với HAS_COLOR=false.
    // Vì HAS_COLOR được cache, test logic supportsColor() thay vào.
    expect(colors.supportsColor()).toBe(false);
  });

  it("trả plain text khi NO_COLOR env set", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true });
    process.env.NO_COLOR = "1";
    expect(colors.supportsColor()).toBe(false);
  });

  it("trả true khi TTY và không NO_COLOR", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true });
    delete process.env.NO_COLOR;
    expect(colors.supportsColor()).toBe(true);
  });

  it("colorByLevel: error → red, warn → yellow, info → cyan", () => {
    // Test với HAS_COLOR state — dùng wrap trực tiếp.
    // Khi HAS_COLOR=true (TTY), kiểm tra ANSI codes có mặt.
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true });
    delete process.env.NO_COLOR;
    // Re-require để lấy module mới với HAS_COLOR=true.
    delete require.cache[require.resolve("../../mitm-client/src/ui/colors.js")];
    const colorMod = require("../../mitm-client/src/ui/colors.js");
    expect(colorMod.HAS_COLOR).toBe(true);

    const redOut = colorMod.colorByLevel("error", "test error");
    expect(redOut).toContain("\x1B[31m");
    expect(redOut).toContain("test error");

    const yellowOut = colorMod.colorByLevel("warn", "test warn");
    expect(yellowOut).toContain("\x1B[33m");

    const cyanOut = colorMod.colorByLevel("info", "test info");
    expect(cyanOut).toContain("\x1B[36m");
  });

  it("colorByLevel: level không xác định → plain text", () => {
    delete require.cache[require.resolve("../../mitm-client/src/ui/colors.js")];
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true });
    delete process.env.NO_COLOR;
    const colorMod = require("../../mitm-client/src/ui/colors.js");
    const out = colorMod.colorByLevel("debug", "test debug");
    expect(out).toBe("test debug");
    expect(out).not.toContain("\x1B[");
  });

  it("statusColor: running → green, stopped → gray, error → red", () => {
    delete require.cache[require.resolve("../../mitm-client/src/ui/colors.js")];
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true });
    delete process.env.NO_COLOR;
    const colorMod = require("../../mitm-client/src/ui/colors.js");

    expect(colorMod.statusColor("running", "running")).toContain("\x1B[32m");
    expect(colorMod.statusColor("stopped", "stopped")).toContain("\x1B[90m");
    expect(colorMod.statusColor("error", "error")).toContain("\x1B[31m");
  });

  it("non-TTY: tất cả color functions trả plain text (không ANSI)", () => {
    delete require.cache[require.resolve("../../mitm-client/src/ui/colors.js")];
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    delete process.env.NO_COLOR;
    const colorMod = require("../../mitm-client/src/ui/colors.js");
    expect(colorMod.HAS_COLOR).toBe(false);

    expect(colorMod.green("text")).toBe("text");
    expect(colorMod.red("text")).toBe("text");
    expect(colorMod.colorByLevel("error", "text")).toBe("text");
    expect(colorMod.statusColor("running", "text")).toBe("text");
  });
});

// ── AC5: Non-TTY password fallback ────────────────────────────

describe("AC5 — password.js fallback", () => {
  const origEnv = process.env.SUDO_PASSWORD;
  const tmpDir = path.join(os.tmpdir(), `mitm-test-pwd-${Date.now()}`);
  let tmpPwdFile;

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    tmpPwdFile = path.join(tmpDir, ".sudo-password");
  });

  afterEach(() => {
    delete process.env.SUDO_PASSWORD;
    if (origEnv !== undefined) process.env.SUDO_PASSWORD = origEnv;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("readPasswordFromEnv: trả password khi SUDO_PASSWORD set", () => {
    process.env.SUDO_PASSWORD = "secret123";
    expect(passwordMod.readPasswordFromEnv()).toBe("secret123");
  });

  it("readPasswordFromEnv: trả null khi SUDO_PASSWORD không set", () => {
    delete process.env.SUDO_PASSWORD;
    expect(passwordMod.readPasswordFromEnv()).toBe(null);
  });

  it("readPasswordFromEnv: trả null khi SUDO_PASSWORD empty", () => {
    process.env.SUDO_PASSWORD = "";
    expect(passwordMod.readPasswordFromEnv()).toBe(null);
  });

  it("readPasswordFromFile: đọc password từ file mode 0o600", () => {
    fs.writeFileSync(tmpPwdFile, "filepwd456\n");
    fs.chmodSync(tmpPwdFile, 0o600);
    expect(passwordMod.readPasswordFromFile(tmpPwdFile)).toBe("filepwd456");
  });

  it("readPasswordFromFile: trả null khi file mode không phải 0o600 (security)", () => {
    fs.writeFileSync(tmpPwdFile, "insecure789\n");
    fs.chmodSync(tmpPwdFile, 0o644); // world-readable — should be rejected
    expect(passwordMod.readPasswordFromFile(tmpPwdFile)).toBe(null);
  });

  it("readPasswordFromFile: trả null khi file không tồn tại", () => {
    expect(passwordMod.readPasswordFromFile("/nonexistent/path/.sudo-password")).toBe(null);
  });
});
