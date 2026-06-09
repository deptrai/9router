import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planPurchaseMigration-"));
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

describe("plan purchase migration", () => {
  it("adds price/duration columns and default plan values", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const cols = db.all(`PRAGMA table_info(plans)`).map((r) => r.name);
    expect(cols).toContain("priceCredits");
    expect(cols).toContain("durationDays");

    const rows = db.all(`SELECT name, priceCredits, durationDays FROM plans WHERE name IN ('free','pro','max') ORDER BY name`);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "free", priceCredits: 0, durationDays: 30 }),
      expect.objectContaining({ name: "pro", priceCredits: 10, durationDays: 30 }),
      expect.objectContaining({ name: "max", priceCredits: 30, durationDays: 30 }),
    ]));
  });
});
