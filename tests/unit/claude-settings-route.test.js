/**
 * C8 — claude-settings env whitelist (commit bd3f8db + 612b3a1).
 *
 * Trước fix: POST nhận bất kỳ key nào trong env → có thể inject env tùy ý vào
 * ~/.claude/settings.json. Sau fix: ALLOWED_ENV_KEYS whitelist cứng, reject array,
 * reject unknown key (400), reject empty/blank value (400).
 *
 * Tests này verify tất cả các nhánh guard của POST handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- mock next/server trước khi import route ---
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data, opts) => ({
      status: opts?.status ?? 200,
      async json() { return data; },
      _data: data,
    })),
  },
}));

// mock child_process exec — giả vờ claude CLI đã install
vi.mock("child_process", () => ({
  exec: vi.fn((_cmd, _opts, cb) => {
    if (typeof _opts === "function") _opts(null, "/usr/local/bin/claude", "");
    else if (typeof cb === "function") cb(null, "/usr/local/bin/claude", "");
  }),
}));

let tempHome;
const origHome = process.env.HOME;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "9router-claude-settings-"));
  // Điều hướng os.homedir() bằng HOME env
  process.env.HOME = tempHome;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  vi.resetModules();
  vi.restoreAllMocks();
});

function makePostRequest(body) {
  return { json: () => Promise.resolve(body) };
}

// --- helpers ---
async function getPost() {
  const { POST } = await import("@/app/api/cli-tools/claude-settings/route.js");
  return POST;
}

// --- POST whitelist tests ---
describe("C8 — POST /api/cli-tools/claude-settings env whitelist", () => {
  it("reject null env → 400", async () => {
    const POST = await getPost();
    const res = await POST(makePostRequest({ env: null }));
    expect(res.status).toBe(400);
    expect(res._data.error).toMatch(/invalid env/i);
  });

  it("reject array env → 400", async () => {
    const POST = await getPost();
    const res = await POST(makePostRequest({ env: ["ANTHROPIC_BASE_URL", "http://x"] }));
    expect(res.status).toBe(400);
    expect(res._data.error).toMatch(/invalid env/i);
  });

  it("reject unknown key → 400 với tên key trong message", async () => {
    const POST = await getPost();
    const res = await POST(makePostRequest({ env: { EVIL_KEY: "bad" } }));
    expect(res.status).toBe(400);
    expect(res._data.error).toMatch(/EVIL_KEY/);
  });

  it("reject empty string value → 400", async () => {
    const POST = await getPost();
    const res = await POST(makePostRequest({ env: { ANTHROPIC_BASE_URL: "" } }));
    expect(res.status).toBe(400);
    expect(res._data.error).toMatch(/non-empty/i);
  });

  it("reject blank (whitespace-only) value → 400", async () => {
    const POST = await getPost();
    const res = await POST(makePostRequest({ env: { ANTHROPIC_BASE_URL: "   " } }));
    expect(res.status).toBe(400);
    expect(res._data.error).toMatch(/non-empty/i);
  });

  it("valid payload → 200 success và ghi file settings.json", async () => {
    const POST = await getPost();
    const res = await POST(makePostRequest({
      env: { ANTHROPIC_BASE_URL: "http://localhost:20128" },
    }));
    expect(res.status).toBe(200);
    expect(res._data.success).toBe(true);

    // File phải tồn tại
    const settingsPath = path.join(tempHome, ".claude", "settings.json");
    const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://localhost:20128/v1");
    expect(written.hasCompletedOnboarding).toBe(true);
  });

  it("ANTHROPIC_BASE_URL normalize: tự thêm /v1 nếu chưa có", async () => {
    const POST = await getPost();
    await POST(makePostRequest({ env: { ANTHROPIC_BASE_URL: "http://myhost:9000" } }));
    const settingsPath = path.join(tempHome, ".claude", "settings.json");
    const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://myhost:9000/v1");
  });

  it("ANTHROPIC_BASE_URL normalize: không thêm /v1 thừa nếu đã có", async () => {
    const POST = await getPost();
    await POST(makePostRequest({ env: { ANTHROPIC_BASE_URL: "http://myhost:9000/v1" } }));
    const settingsPath = path.join(tempHome, ".claude", "settings.json");
    const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://myhost:9000/v1");
  });

  it("merge env: giữ lại keys hiện có không nằm trong request", async () => {
    // Seed file settings ban đầu với ANTHROPIC_AUTH_TOKEN
    const claudeDir = path.join(tempHome, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "existing-token" }, hasCompletedOnboarding: false }),
    );

    const POST = await getPost();
    await POST(makePostRequest({ env: { ANTHROPIC_BASE_URL: "http://relay:20128" } }));

    const written = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf-8"));
    // Token cũ phải còn
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("existing-token");
    // URL mới phải có
    expect(written.env.ANTHROPIC_BASE_URL).toMatch(/\/v1$/);
  });

  it("6 allowed keys đều được chấp nhận", async () => {
    const POST = await getPost();
    const res = await POST(makePostRequest({
      env: {
        ANTHROPIC_BASE_URL: "http://relay:20128",
        ANTHROPIC_AUTH_TOKEN: "tok-123",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
        API_TIMEOUT_MS: "30000",
      },
    }));
    expect(res.status).toBe(200);
  });
});
