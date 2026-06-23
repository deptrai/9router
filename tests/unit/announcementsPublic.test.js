// Story M.6 — GET /api/announcements public time-window filtering
// Active + within [startsAt, endsAt) window only; disabled / expired / not-yet-started
// must be excluded. Uses a real temp DB so migration 017 + the SQL filter are exercised.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-announce-"));
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

// Insert an announcement row directly. SQLite datetime('now') is UTC, so use
// ISO strings offset from now for the window boundaries.
function isoOffset(ms) {
  return new Date(Date.now() + ms).toISOString().replace("T", " ").slice(0, 19);
}

async function seed(rows) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  let i = 0;
  for (const r of rows) {
    db.run(
      `INSERT INTO announcements (id, title, body, isActive, startsAt, endsAt, createdBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id ?? `a-${i++}`,
        r.title ?? "T",
        r.body ?? "B",
        r.isActive ?? 1,
        r.startsAt ?? null,
        r.endsAt ?? null,
        "admin",
        r.createdAt ?? new Date().toISOString(),
      ]
    );
  }
}

async function fetchPublic() {
  const { GET } = await import("@/app/api/announcements/route.js");
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.announcements.map((a) => a.id);
}

describe("GET /api/announcements — public time-window (M.6)", () => {
  it("active, no window → visible", async () => {
    await seed([{ id: "always" }]);
    expect(await fetchPublic()).toContain("always");
  });

  it("isActive = 0 → hidden", async () => {
    await seed([{ id: "disabled", isActive: 0 }]);
    expect(await fetchPublic()).not.toContain("disabled");
  });

  it("endsAt in the past → hidden (expired)", async () => {
    await seed([{ id: "expired", endsAt: isoOffset(-60_000) }]);
    expect(await fetchPublic()).not.toContain("expired");
  });

  it("startsAt in the future → hidden (scheduled)", async () => {
    await seed([{ id: "scheduled", startsAt: isoOffset(60 * 60_000) }]);
    expect(await fetchPublic()).not.toContain("scheduled");
  });

  it("active within window → visible", async () => {
    await seed([{ id: "live", startsAt: isoOffset(-60_000), endsAt: isoOffset(60 * 60_000) }]);
    expect(await fetchPublic()).toContain("live");
  });

  it("mixed set → only the live one surfaces", async () => {
    await seed([
      { id: "ok", startsAt: isoOffset(-60_000), endsAt: isoOffset(60 * 60_000) },
      { id: "off", isActive: 0 },
      { id: "old", endsAt: isoOffset(-1000) },
      { id: "future", startsAt: isoOffset(60 * 60_000) },
    ]);
    const ids = await fetchPublic();
    expect(ids).toContain("ok");
    expect(ids).not.toContain("off");
    expect(ids).not.toContain("old");
    expect(ids).not.toContain("future");
  });
});
