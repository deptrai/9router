import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const PROVIDER = "openai-compatible-chat-870524de-51e0-4602-86b0-4329019ad305";
const VUZ_DATA = JSON.stringify({
  defaultModel: "claude-sonnet-4.6",
  apiKey: "sk-test-key",
  testStatus: "active",
  providerSpecificData: { prefix: "vuz", apiType: "chat", baseUrl: "https://xapi.labpinky.com/v1", nodeName: "vuz" },
  consecutiveUseCount: 5,
  lastUsedAt: "2026-06-14T00:00:00.000Z",
  lastError: "timeout",
  lastErrorAt: "2026-06-13T00:00:00.000Z",
  errorCode: 502,
  modelLock_claudeOpus: "2026-06-14T01:00:00.000Z",
  modelLock_claudeSonnet: "2026-06-14T02:00:00.000Z",
  backoffLevel: 0,
});

let rawDb;
let adapter;
let vuzId;

function createVuzConnection(conn) {
  const now = new Date().toISOString();
  const stmt = rawDb.prepare(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, ownerUserId, entitlementId)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
  );
  stmt.run(conn.id, conn.provider, "apikey", conn.name, "", 1, 1, conn.data, now, now);
}

function makeAdapter(raw) {
  return {
    get: (sql, params) => raw.prepare(sql).get(...(params || [])),
    run: (sql, params) => raw.prepare(sql).run(...(params || [])),
    all: (sql, params) => raw.prepare(sql).all(...(params || [])),
    exec: (sql) => raw.exec(sql),
  };
}

beforeAll(() => {
  const Database = require("better-sqlite3");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig010-"));
  const dbPath = path.join(tempDir, "test.sqlite");
  rawDb = new Database(dbPath);
  adapter = makeAdapter(rawDb);

  // Create the providerConnections table (simplified schema)
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS providerConnections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      authType TEXT NOT NULL,
      name TEXT,
      email TEXT,
      priority INTEGER,
      isActive INTEGER DEFAULT 1,
      data TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      ownerUserId TEXT,
      entitlementId TEXT
    )
  `);

  // Insert a vuz connection
  vuzId = "test-vuz-uuid-0001";
  createVuzConnection({ id: vuzId, provider: PROVIDER, name: "vuz", data: VUZ_DATA });
});

afterAll(() => {
  if (rawDb) {
    const p = rawDb.name;
    rawDb.close();
    try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch {}
  }
});

describe("Migration 010 — vuz-2 connection", () => {
  it("creates vuz-2 when vuz exists", async () => {
    const migration = (await import("../../src/lib/db/migrations/010-vuz2-connection.js")).default;
    migration.up(adapter);

    const row = adapter.get("SELECT * FROM providerConnections WHERE name = ?", ["vuz-2"]);
    expect(row).toBeDefined();
    expect(row.name).toBe("vuz-2");
    expect(row.provider).toBe(PROVIDER);
    expect(row.isActive).toBe(1);
  });

  it("vuz-2 has cleaned data (no error tracking)", async () => {
    const row = adapter.get("SELECT data FROM providerConnections WHERE name = ?", ["vuz-2"]);
    const data = JSON.parse(row.data);
    expect(data.consecutiveUseCount).toBe(0);
    expect(data.lastUsedAt).toBeUndefined();
    expect(data.lastError).toBeNull();
    expect(data.lastErrorAt).toBeNull();
    expect(data.errorCode).toBeNull();
    expect(data.backoffLevel).toBe(0);
  });

  it("vuz-2 has no model locks", async () => {
    const row = adapter.get("SELECT data FROM providerConnections WHERE name = ?", ["vuz-2"]);
    const data = JSON.parse(row.data);
    const lockKeys = Object.keys(data).filter(k => k.startsWith("modelLock_"));
    for (const key of lockKeys) {
      expect(data[key]).toBeNull();
    }
  });

  it("vuz-2 keeps provider config intact", async () => {
    const row = adapter.get("SELECT data FROM providerConnections WHERE name = ?", ["vuz-2"]);
    const data = JSON.parse(row.data);
    expect(data.apiKey).toBe("sk-test-key");
    expect(data.providerSpecificData.baseUrl).toBe("https://xapi.labpinky.com/v1");
    expect(data.testStatus).toBe("active");
  });

  it("is idempotent — running again does not create duplicate", async () => {
    const migration = (await import("../../src/lib/db/migrations/010-vuz2-connection.js")).default;
    migration.up(adapter);

    const rows = adapter.all("SELECT * FROM providerConnections WHERE name = ?", ["vuz-2"]);
    expect(rows.length).toBe(1);
  });

  it("gracefully skips when vuz does not exist", async () => {
    const unknownCtx = (() => {
      const Database = require("better-sqlite3");
      const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig010-empty-"));
      const r = new Database(path.join(tempDir2, "empty.sqlite"));
      const a = makeAdapter(r);
      a.exec(`CREATE TABLE IF NOT EXISTS providerConnections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL,
        name TEXT, email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        ownerUserId TEXT, entitlementId TEXT
      )`);
      return { db: a, cleanup: () => { r.close(); fs.rmSync(tempDir2, { recursive: true, force: true }); } };
    })();

    try {
      const migration = (await import("../../src/lib/db/migrations/010-vuz2-connection.js")).default;
      expect(() => migration.up(unknownCtx.db)).not.toThrow();
    } finally {
      unknownCtx.cleanup();
    }
  });
});
