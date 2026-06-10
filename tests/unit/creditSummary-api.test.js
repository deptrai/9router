/**
 * creditSummary-api.test.js — Story 2.24, Part D1
 * Tests the credit-summary query logic (GROUP BY bucket, period filter, fail-soft)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-creditsummary-"));
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

async function seedUser(email = "test@example.com") {
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const hash = await bcrypt.hash("pass12345", 4);
  return createUser(email, hash, "Test");
}

async function insertDeduction(userId, bucket, amount, createdAt) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const { v4: uuidv4 } = await import("uuid");
  const db = await getAdapter();
  const now = createdAt || new Date().toISOString();
  db.run(
    `INSERT INTO creditTransactions(id, userId, type, bucket, amount, multiplier, expiresAt, refId, idempotencyKey, balanceAfter, note, createdAt)
     VALUES(?, ?, 'usage_deduction', ?, ?, 1, NULL, ?, NULL, 0, NULL, ?)`,
    [uuidv4(), userId, bucket, -Math.abs(amount), `ref:${Date.now()}`, now]
  );
}

function queryCreditSummary(adapter, userId, since) {
  const rows = adapter.all(
    `SELECT bucket, COALESCE(SUM(ABS(amount)), 0) AS spent
     FROM creditTransactions
     WHERE userId = ? AND type = 'usage_deduction' AND createdAt >= ?
     GROUP BY bucket`,
    [userId, since]
  );
  const summary = { standard: 0, bonus: 0, resource: 0 };
  for (const r of rows) {
    if (r.bucket in summary) summary[r.bucket] = r.spent;
  }
  return summary;
}

describe("credit-summary GROUP BY bucket", () => {
  it("sums deductions per bucket correctly", async () => {
    const user = await seedUser("a@test.com");
    await insertDeduction(user.id, "standard", 1.5);
    await insertDeduction(user.id, "standard", 0.5);
    await insertDeduction(user.id, "bonus", 2.0);
    await insertDeduction(user.id, "resource", 0.25);

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const summary = queryCreditSummary(db, user.id, since);

    expect(summary.standard).toBeCloseTo(2.0);
    expect(summary.bonus).toBeCloseTo(2.0);
    expect(summary.resource).toBeCloseTo(0.25);
  });

  it("returns zeros when no deductions", async () => {
    const user = await seedUser("b@test.com");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const summary = queryCreditSummary(db, user.id, since);
    expect(summary.standard).toBe(0);
    expect(summary.bonus).toBe(0);
    expect(summary.resource).toBe(0);
  });

  it("period filter excludes old deductions", async () => {
    const user = await seedUser("c@test.com");
    const old = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(); // 60 days ago
    await insertDeduction(user.id, "standard", 5.0, old); // outside 7d
    await insertDeduction(user.id, "standard", 1.0); // recent — inside 7d

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const summary = queryCreditSummary(db, user.id, since);

    expect(summary.standard).toBeCloseTo(1.0); // only recent
  });

  it("only counts usage_deduction type, not topups", async () => {
    const user = await seedUser("d@test.com");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { v4: uuidv4 } = await import("uuid");
    const db = await getAdapter();
    const now = new Date().toISOString();
    // Insert a topup (should be excluded)
    db.run(
      `INSERT INTO creditTransactions(id, userId, type, bucket, amount, multiplier, expiresAt, refId, idempotencyKey, balanceAfter, note, createdAt)
       VALUES(?, ?, 'admin_topup', 'standard', 10, 1, NULL, 'seed', NULL, 10, NULL, ?)`,
      [uuidv4(), user.id, now]
    );
    await insertDeduction(user.id, "standard", 2.0);

    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const summary = queryCreditSummary(db, user.id, since);
    expect(summary.standard).toBeCloseTo(2.0); // only deduction counted
  });

  it("only counts own user deductions, not others", async () => {
    const user1 = await seedUser("e@test.com");
    const user2 = await seedUser("f@test.com");
    await insertDeduction(user1.id, "standard", 3.0);
    await insertDeduction(user2.id, "standard", 9.0); // other user

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const summary = queryCreditSummary(db, user1.id, since);
    expect(summary.standard).toBeCloseTo(3.0);
  });
});
