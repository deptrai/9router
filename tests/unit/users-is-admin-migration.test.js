// Migration 018 — users.isAdmin column + ADMIN_EMAIL promotion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let rawDb;
let adapter;
let tempDir;
const originalAdminEmail = process.env.ADMIN_EMAIL;

function makeAdapter(raw) {
  return {
    get: (sql, params) => raw.prepare(sql).get(...(params || [])),
    run: (sql, params) => raw.prepare(sql).run(...(params || [])),
    all: (sql, params) => raw.prepare(sql).all(...(params || [])),
    exec: (sql) => raw.exec(sql),
  };
}

function seedUser(email) {
  const now = new Date().toISOString();
  adapter.run(
    `INSERT INTO users(id, email, passwordHash, displayName, isActive, isEmailVerified, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, 1, 0, ?, ?)`,
    [`id-${email}`, email, "hash", email, now, now]
  );
}

beforeEach(() => {
  const Database = require("better-sqlite3");
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig018-"));
  rawDb = new Database(path.join(tempDir, "test.sqlite"));
  adapter = makeAdapter(rawDb);
  // users table WITHOUT isAdmin (pre-migration state)
  adapter.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      displayName TEXT,
      isActive INTEGER DEFAULT 1,
      isEmailVerified INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  delete process.env.ADMIN_EMAIL;
});

afterEach(() => {
  if (rawDb) { try { rawDb.close(); } catch {} }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = originalAdminEmail;
});

describe("Migration 018 — users.isAdmin", () => {
  it("adds isAdmin column defaulting to 0", async () => {
    seedUser("a@example.com");
    const migration = (await import("../../src/lib/db/migrations/018-users-is-admin.js")).default;
    migration.up(adapter);

    const cols = adapter.all(`PRAGMA table_info(users)`);
    expect(cols.some((c) => c.name === "isAdmin")).toBe(true);
    const row = adapter.get(`SELECT isAdmin FROM users WHERE email = ?`, ["a@example.com"]);
    expect(row.isAdmin).toBe(0);
  });

  it("promotes the ADMIN_EMAIL user (case-insensitive)", async () => {
    process.env.ADMIN_EMAIL = "Boss@Example.com";
    seedUser("boss@example.com");
    seedUser("pleb@example.com");
    const migration = (await import("../../src/lib/db/migrations/018-users-is-admin.js")).default;
    migration.up(adapter);

    expect(adapter.get(`SELECT isAdmin FROM users WHERE email = ?`, ["boss@example.com"]).isAdmin).toBe(1);
    expect(adapter.get(`SELECT isAdmin FROM users WHERE email = ?`, ["pleb@example.com"]).isAdmin).toBe(0);
  });

  it("is idempotent — running twice does not throw", async () => {
    seedUser("a@example.com");
    const migration = (await import("../../src/lib/db/migrations/018-users-is-admin.js")).default;
    migration.up(adapter);
    expect(() => migration.up(adapter)).not.toThrow();
  });

  it("no ADMIN_EMAIL set → no promotion", async () => {
    seedUser("a@example.com");
    const migration = (await import("../../src/lib/db/migrations/018-users-is-admin.js")).default;
    migration.up(adapter);
    expect(adapter.get(`SELECT isAdmin FROM users WHERE email = ?`, ["a@example.com"]).isAdmin).toBe(0);
  });
});
