import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const PROVIDER = "openai-compatible-chat-pool-test";

let rawDb;
let adapter;
let dbPath;

function makeAdapter(raw) {
  return {
    get: (sql, params) => raw.prepare(sql).get(...(params || [])),
    run: (sql, params) => raw.prepare(sql).run(...(params || [])),
    all: (sql, params) => raw.prepare(sql).all(...(params || [])),
    exec: (sql) => raw.exec(sql),
  };
}

function insertConnection(name, priority, isActive, extra = {}) {
  const now = new Date().toISOString();
  const data = JSON.stringify({
    apiKey: "sk-test",
    testStatus: "active",
    providerSpecificData: { baseUrl: "https://test.api/v1" },
    ...extra,
  });
  adapter.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, ownerUserId, entitlementId)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [`id-${name}`, PROVIDER, "apikey", name, "", priority, isActive ? 1 : 0, data, now, now]
  );
}

function countActive() {
  return adapter.all("SELECT * FROM providerConnections WHERE provider = ? AND isActive = 1 ORDER BY priority", [PROVIDER]);
}

beforeAll(() => {
  const Database = require("better-sqlite3");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-authpool-"));
  dbPath = path.join(tempDir, "test.sqlite");
  rawDb = new Database(dbPath);
  adapter = makeAdapter(rawDb);

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

  // Insert 3 connections: 2 active, 1 inactive
  insertConnection("primary", 1, true, { consecutiveUseCount: 5 });
  insertConnection("secondary", 2, true, {});
  insertConnection("disabled", 3, false, {});
});

afterAll(() => {
  if (rawDb) {
    rawDb.close();
    try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch {}
  }
});

describe("Provider connection pool", () => {
  it("counts only active connections", () => {
    const rows = countActive();
    expect(rows.length).toBe(2);
  });

  it("sorts by priority ascending", () => {
    const rows = countActive();
    expect(rows[0].name).toBe("primary");
    expect(rows[1].name).toBe("secondary");
  });

  it("returns disabled connections only when queried without isActive filter", () => {
    const all = adapter.all("SELECT * FROM providerConnections WHERE provider = ?", [PROVIDER]);
    expect(all.length).toBe(3);
    const inactive = all.filter(r => r.isActive === 0);
    expect(inactive.length).toBe(1);
    expect(inactive[0].name).toBe("disabled");
  });

  it("single connection scenario: total=1 when 1 active", () => {
    const Database = require("better-sqlite3");
    const singleRaw = new Database(path.join(path.dirname(dbPath), "single.sqlite"));
    const singleAdap = makeAdapter(singleRaw);
    try {
      singleAdap.exec(`CREATE TABLE IF NOT EXISTS providerConnections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL,
        name TEXT, email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        ownerUserId TEXT, entitlementId TEXT
      )`);
      const now = new Date().toISOString();
      singleAdap.run(
        `INSERT INTO providerConnections VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        ["only-one", PROVIDER, "apikey", "solo", "", 1, 1, JSON.stringify({ apiKey: "sk-test" }), now, now]
      );
      const rows = singleAdap.all("SELECT * FROM providerConnections WHERE provider = ? AND isActive = 1", [PROVIDER]);
      expect(rows.length).toBe(1);
    } finally {
      singleRaw.close();
    }
  });
});
