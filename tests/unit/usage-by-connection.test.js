// Story N.3 — Per-connection usage aggregation tests
// Cover sumUsageByConnection (model filter, time window, empty) và
// getConnectionUsageStats (all windows, perModel top 5, empty connection).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-by-conn-"));
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
});

async function seedUsage() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();

  const now = new Date();
  const isoNow = now.toISOString();
  // 3 ngày trước (ngoài 24h nhưng trong 7d)
  const oldDate = new Date(now.getTime() - 3 * 86400000);
  const isoOld = oldDate.toISOString();
  // 10 ngày trước (ngoài 7d)
  const veryOldDate = new Date(now.getTime() - 10 * 86400000);
  const isoVeryOld = veryOldDate.toISOString();

  const ins = (connectionId, model, provider, ts, prompt, completion, cost) => {
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ts, provider, model, connectionId, null, "/v1/chat/completions", prompt, completion, cost, "ok", "{}", "{}"]
    );
  };

  // conn-1: today + old + veryOld, multiple models
  ins("conn-1", "gpt-4", "windsurf", isoNow, 100, 50, 0.001);
  ins("conn-1", "gpt-4", "windsurf", isoNow, 200, 100, 0.002);
  ins("conn-1", "claude-3", "windsurf", isoOld, 500, 200, 0.005);
  ins("conn-1", "gpt-4", "windsurf", isoVeryOld, 1000, 500, 0.01);

  // conn-2: chỉ 1 entry today
  ins("conn-2", "gpt-4", "windsurf", isoNow, 300, 150, 0.003);

  return { isoNow, isoOld, isoVeryOld };
}

describe("sumUsageByConnection (AC1)", () => {
  it("tính tổng tokens/requests/cost cho connectionId trong time window", async () => {
    await seedUsage();
    const { sumUsageByConnection } = await import("@/lib/db/repos/usageRepo.js");

    // allTime (sinceISO=null)
    const all = await sumUsageByConnection("conn-1", null, null);
    expect(all.tokens).toBe((100 + 50) + (200 + 100) + (500 + 200) + (1000 + 500));
    expect(all.requests).toBe(4);
    expect(all.cost).toBeCloseTo(0.001 + 0.002 + 0.005 + 0.01, 5);
  });

  it("lọc theo sinceISO — chỉ entries trong 24h", async () => {
    const { isoNow } = await seedUsage();
    const { sumUsageByConnection } = await import("@/lib/db/repos/usageRepo.js");

    const last24h = await sumUsageByConnection("conn-1", null, isoNow);
    // Chỉ 2 entries today (cùng timestamp isoNow)
    expect(last24h.tokens).toBe((100 + 50) + (200 + 100));
    expect(last24h.requests).toBe(2);
  });

  it("lọc theo model — chỉ gpt-4", async () => {
    await seedUsage();
    const { sumUsageByConnection } = await import("@/lib/db/repos/usageRepo.js");

    const gpt4 = await sumUsageByConnection("conn-1", "gpt-4", null);
    expect(gpt4.tokens).toBe((100 + 50) + (200 + 100) + (1000 + 500));
    expect(gpt4.requests).toBe(3);
  });

  it("connection không tồn tại → trả zeros", async () => {
    await seedUsage();
    const { sumUsageByConnection } = await import("@/lib/db/repos/usageRepo.js");

    const result = await sumUsageByConnection("nonexistent", null, null);
    expect(result.tokens).toBe(0);
    expect(result.requests).toBe(0);
    expect(result.cost).toBe(0);
  });

  it("model='*' → mọi model", async () => {
    await seedUsage();
    const { sumUsageByConnection } = await import("@/lib/db/repos/usageRepo.js");

    const all = await sumUsageByConnection("conn-1", "*", null);
    expect(all.requests).toBe(4);
  });
});

describe("getConnectionUsageStats (AC2)", () => {
  it("trả đủ windows: today, last24h, last7d, allTime, perModel", async () => {
    await seedUsage();
    const { getConnectionUsageStats } = await import("@/lib/db/repos/usageRepo.js");

    const stats = await getConnectionUsageStats("conn-1");
    expect(stats).toHaveProperty("today");
    expect(stats).toHaveProperty("last24h");
    expect(stats).toHaveProperty("last7d");
    expect(stats).toHaveProperty("allTime");
    expect(stats).toHaveProperty("perModel");
    expect(Array.isArray(stats.perModel)).toBe(true);

    // allTime = 4 requests
    expect(stats.allTime.requests).toBe(4);
    expect(stats.allTime.tokens).toBe((100 + 50) + (200 + 100) + (500 + 200) + (1000 + 500));
  });

  it("today chỉ count entries từ 00:00 local", async () => {
    await seedUsage();
    const { getConnectionUsageStats } = await import("@/lib/db/repos/usageRepo.js");

    const stats = await getConnectionUsageStats("conn-1");
    // 2 entries today (cùng timestamp now)
    expect(stats.today.requests).toBe(2);
  });

  it("last7d bao gồm entries cũ (3 ngày) nhưng không quá 7d", async () => {
    await seedUsage();
    const { getConnectionUsageStats } = await import("@/lib/db/repos/usageRepo.js");

    const stats = await getConnectionUsageStats("conn-1");
    // 3 entries trong 7d (2 today + 1 từ 3 ngày trước)
    expect(stats.last7d.requests).toBe(3);
  });

  it("perModel — top 5 by tokens, sắp xếp giảm dần", async () => {
    await seedUsage();
    const { getConnectionUsageStats } = await import("@/lib/db/repos/usageRepo.js");

    const stats = await getConnectionUsageStats("conn-1");
    // gpt-4: (100+50)+(200+100)+(1000+500) = 1950
    // claude-3: (500+200) = 700
    expect(stats.perModel.length).toBe(2);
    expect(stats.perModel[0].model).toBe("gpt-4");
    expect(stats.perModel[0].tokens).toBe(1950);
    expect(stats.perModel[1].model).toBe("claude-3");
    expect(stats.perModel[1].tokens).toBe(700);
  });

  it("perModel — tối đa 5 entries", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const now = new Date().toISOString();
    // Insert 6 models khác nhau cho conn-3
    for (let i = 0; i < 6; i++) {
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [now, "windsurf", `model-${i}`, "conn-3", null, "/v1/chat/completions", (i + 1) * 100, 0, 0, "ok", "{}", "{}"]
      );
    }
    const { getConnectionUsageStats } = await import("@/lib/db/repos/usageRepo.js");
    const stats = await getConnectionUsageStats("conn-3");
    expect(stats.perModel.length).toBe(5);
    // model-5 có nhiều tokens nhất (600)
    expect(stats.perModel[0].model).toBe("model-5");
  });

  it("connection rỗng → tất cả windows zeros, perModel rỗng", async () => {
    await seedUsage();
    const { getConnectionUsageStats } = await import("@/lib/db/repos/usageRepo.js");

    const stats = await getConnectionUsageStats("empty-conn");
    expect(stats.today.requests).toBe(0);
    expect(stats.today.tokens).toBe(0);
    expect(stats.today.cost).toBe(0);
    expect(stats.last24h.requests).toBe(0);
    expect(stats.last7d.requests).toBe(0);
    expect(stats.allTime.requests).toBe(0);
    expect(stats.perModel).toEqual([]);
  });
});
