// Verify schema migration chain runs correctly across versions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig-"));
  process.env.DATA_DIR = tempDir;
  // Reset global singleton so each test gets fresh adapter pointed at tempDir
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  // Close adapter to release file handles before rm
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Schema migrations", () => {
  it("fresh DB → applies migrations & stamps schemaVersion", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      "_meta", "settings", "providerConnections", "providerNodes",
      "proxyPools", "apiKeys", "combos", "kv", "usageHistory", "usageDaily", "requestDetails",
    ]));
  });

  it("existing DB at older schemaVersion → re-applies pending migrations on restart", async () => {
    // 1st boot
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, ['{"foo":"bar"}']);
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);
    db.close?.();

    // 2nd boot: full reset to simulate process restart
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();
    const row = db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const settings = db2.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar" });
  });

  it("fresh DB → seeds context-safe combo presets", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const rows = db.all(`SELECT name, models FROM combos ORDER BY name`);
    const byName = Object.fromEntries(rows.map((row) => [row.name, JSON.parse(row.models)]));

    expect(byName["sonnet-4.6"]).toEqual([
      "kr/claude-sonnet-4.6-thinking-agentic",
      "kr/claude-sonnet-4.6-thinking",
      "kr/claude-sonnet-4.6-agentic",
      "kr/claude-sonnet-4.6",
      "cx/gpt-5.5",
    ]);
    expect(byName["opus-4.8"]).toEqual([
      "kr/claude-opus-4.8-thinking-agentic",
      "kr/claude-opus-4.8-thinking",
      "kr/claude-opus-4.8-agentic",
      "kr/claude-opus-4.8",
      "cx/gpt-5.5",
    ]);
    expect(byName["dev-mini"]).toEqual(["kr/claude-haiku-4.5", "kr/auto-thinking", "kr/auto", "cx/gpt-5.5"]);
    expect(byName["haiku-4.5"]).toEqual(["kr/claude-haiku-4.5", "kr/auto-thinking", "kr/auto", "cx/gpt-5.4-mini", "cx/gpt-5.5"]);
    expect(byName["deep-search"]).toEqual(["cx/gpt-5.5"]);
    expect(byName.develop).toEqual(["kr/claude-sonnet-4.6", "cx/gpt-5.5"]);
    expect(byName.review).toEqual(["kr/claude-opus-4.8-thinking", "cx/gpt-5.5"]);
  });

  it("older DB → normalizes stale combo presets without deleting custom combos", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const staleUpdatedAt = "2026-01-01T00:00:00.000Z";

    db.run(
      `UPDATE combos SET models = ?, updatedAt = ? WHERE name = 'sonnet-4.6'`,
      [JSON.stringify(["kr/claude-sonnet-4.6"]), staleUpdatedAt]
    );
    db.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, NULL, ?, ?, ?)`,
      ["custom-combo-id", "custom-combo", JSON.stringify(["provider/custom-model"]), staleUpdatedAt, staleUpdatedAt]
    );
    db.run(`UPDATE _meta SET value = '6' WHERE key = 'schemaVersion'`);
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();

    const sonnet = db2.get(`SELECT models, updatedAt FROM combos WHERE name = 'sonnet-4.6'`);
    expect(JSON.parse(sonnet.models)).toEqual([
      "kr/claude-sonnet-4.6-thinking-agentic",
      "kr/claude-sonnet-4.6-thinking",
      "kr/claude-sonnet-4.6-agentic",
      "kr/claude-sonnet-4.6",
      "cx/gpt-5.5",
    ]);
    expect(sonnet.updatedAt).not.toBe(staleUpdatedAt);

    const custom = db2.get(`SELECT models, updatedAt FROM combos WHERE name = 'custom-combo'`);
    expect(JSON.parse(custom.models)).toEqual(["provider/custom-model"]);
    expect(custom.updatedAt).toBe(staleUpdatedAt);
  });

  it("fresh DB + legacy db.json → imports data automatically", async () => {
    // Simulate user upgrading: place legacy JSON in DATA_DIR before first boot
    const legacyUpdatedAt = "2026-01-01T00:00:00.000Z";
    const legacy = {
      settings: { foo: "legacy-value" },
      apiKeys: [{ id: "k1", key: "abc", name: "test", createdAt: new Date().toISOString() }],
      combos: [{ id: "legacy-sonnet", name: "sonnet-4.6", models: ["kr/claude-sonnet-4.6"], createdAt: legacyUpdatedAt, updatedAt: legacyUpdatedAt }],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "legacy-value" });

    const keys = db.all(`SELECT * FROM apiKeys`);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("abc");

    const aliases = db.all(`SELECT * FROM kv WHERE scope='modelAliases'`);
    expect(aliases).toHaveLength(1);

    const sonnet = db.get(`SELECT models, updatedAt FROM combos WHERE name = 'sonnet-4.6'`);
    expect(JSON.parse(sonnet.models)).toEqual([
      "kr/claude-sonnet-4.6-thinking-agentic",
      "kr/claude-sonnet-4.6-thinking",
      "kr/claude-sonnet-4.6-agentic",
      "kr/claude-sonnet-4.6",
      "cx/gpt-5.5",
    ]);
    expect(sonnet.updatedAt).not.toBe(legacyUpdatedAt);
  });

  it("auto-sync re-creates missing index when DB lacks it", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    expect(db.all(`PRAGMA index_list(providerNodes)`).map(i => i.name)).not.toContain("idx_pn_type");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    const idx = db2.all(`PRAGMA index_list(providerNodes)`).map(i => i.name);
    expect(idx).toContain("idx_pn_type");
  });
});
