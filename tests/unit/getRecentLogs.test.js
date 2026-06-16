/**
 * C11 — getRecentLogs await fix (commit bd3f8db).
 *
 * Trước fix: `const db = getAdapter()` (thiếu await) → db là Promise, không phải
 * adapter object → db.all() throw "db.all is not a function" tại runtime.
 * Sau fix: `const db = await getAdapter()` → hoạt động đúng.
 *
 * Tests kiểm chứng: hàm trả mảng đúng format, không throw, graceful khi rỗng.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-getRecentLogs-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  vi.resetModules();
});

async function seedUsageRow(db, overrides = {}) {
  const defaults = {
    timestamp: new Date().toISOString(),
    provider: "openai-compatible-vuz",
    model: "claude-sonnet-4-6",
    connectionId: "conn-test-1",
    promptTokens: 100,
    completionTokens: 50,
    status: "done",
  };
  const r = { ...defaults, ...overrides };
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens, completionTokens, status)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [r.timestamp, r.provider, r.model, r.connectionId, r.promptTokens, r.completionTokens, r.status],
  );
}

describe("C11 — getRecentLogs await fix", () => {
  it("không throw khi bảng rỗng — trả mảng rỗng", async () => {
    const { getRecentLogs } = await import("@/lib/db/repos/usageRepo.js");
    const result = await getRecentLogs();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("trả mảng string khi có dữ liệu — mỗi phần tử có đủ trường pipe-delimited", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { getRecentLogs } = await import("@/lib/db/repos/usageRepo.js");

    const db = await getAdapter();
    await seedUsageRow(db, { model: "claude-opus-4-8", promptTokens: 200, completionTokens: 80 });

    const logs = await getRecentLogs();
    expect(logs).toHaveLength(1);

    const line = logs[0];
    expect(typeof line).toBe("string");
    // Format: "dd-mm-yyyy HH:MM:SS | model | PROVIDER | account | sent | received | status"
    const parts = line.split("|").map((s) => s.trim());
    expect(parts.length).toBeGreaterThanOrEqual(7);
    expect(parts[1]).toBe("claude-opus-4-8");         // model
    expect(parts[2]).toBe("OPENAI-COMPATIBLE-VUZ");    // provider uppercase
    expect(parts[4]).toBe("200");                      // promptTokens
    expect(parts[5]).toBe("80");                       // completionTokens
    expect(parts[6]).toBe("done");                     // status
  });

  it("trả đúng số dòng và giới hạn theo limit", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { getRecentLogs } = await import("@/lib/db/repos/usageRepo.js");

    const db = await getAdapter();
    for (let i = 0; i < 5; i++) {
      await seedUsageRow(db, { model: `model-${i}` });
    }

    const all = await getRecentLogs(200);
    expect(all).toHaveLength(5);

    const limited = await getRecentLogs(3);
    expect(limited).toHaveLength(3);
  });

  it("trả mảng rỗng khi DB lỗi — không throw ra ngoài (graceful catch)", async () => {
    // Mock getAdapter throw sau khi module đã load
    vi.doMock("@/lib/db/driver.js", () => ({
      getAdapter: vi.fn().mockRejectedValue(new Error("DB connection failed")),
    }));
    vi.resetModules();

    const { getRecentLogs } = await import("@/lib/db/repos/usageRepo.js");
    const result = await getRecentLogs();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});
