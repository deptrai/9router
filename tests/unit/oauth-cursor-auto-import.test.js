// Tests for GET /api/oauth/cursor/auto-import (refactored handler).
// The handler probes platform-specific candidate paths, then extracts tokens from the
// Cursor SQLite state DB via better-sqlite3 (with a sqlite3-CLI fallback). These tests
// use a REAL temp sqlite fixture (better-sqlite3 is available) instead of brittle mocks.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// NextResponse.json shim → returns an inspectable object
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({ status: init?.status || 200, body, json: async () => body })),
  },
}));

// Mock the handler's `import { homedir } from "os"` to point at our temp home.
// (Test code itself imports "node:os" — a different specifier — so it stays real.)
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, homedir: () => globalThis.__cursorTempHome },
    homedir: () => globalThis.__cursorTempHome,
  };
});

let tempHome;
const realPlatform = process.platform;

function macDbPath(home) {
  return path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
}

function writeCursorDb(dbPath, rows) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("CREATE TABLE itemTable (key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT INTO itemTable (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(rows)) insert.run(k, v);
  db.close();
}

async function loadGET() {
  vi.resetModules();
  const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
  return mod.GET;
}

describe("GET /api/oauth/cursor/auto-import", () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cursor-"));
    globalThis.__cursorTempHome = tempHome;
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });

  afterEach(() => {
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
    Object.defineProperty(process, "platform", { value: realPlatform, writable: true });
    delete globalThis.__cursorTempHome;
  });

  it("returns found:false with checked-locations message when no db exists", async () => {
    const GET = await loadGET();
    const res = await GET();
    expect(res.body.found).toBe(false);
    expect(res.body.error).toContain("Cursor database not found. Checked locations:");
  });

  it("extracts accessToken + machineId from the Cursor db (darwin)", async () => {
    writeCursorDb(macDbPath(tempHome), {
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });
    const GET = await loadGET();
    const res = await GET();
    expect(res.body.found).toBe(true);
    expect(res.body.accessToken).toBe("test-token");
    expect(res.body.machineId).toBe("test-machine-id");
  });

  it("unwraps JSON-encoded string values", async () => {
    writeCursorDb(macDbPath(tempHome), {
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    });
    const GET = await loadGET();
    const res = await GET();
    expect(res.body.found).toBe(true);
    expect(res.body.accessToken).toBe("json-token");
    expect(res.body.machineId).toBe("json-machine-id");
  });

  it("returns manual-paste fallback when db exists but has no tokens", async () => {
    writeCursorDb(macDbPath(tempHome), { "some/unrelated/key": "x" });
    const GET = await loadGET();
    const res = await GET();
    expect(res.body.found).toBe(false);
    expect(res.body.windowsManual).toBe(true);
    expect(res.body.dbPath).toBe(macDbPath(tempHome));
  });
});
