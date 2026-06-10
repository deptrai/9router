import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-creditBucket-"));
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

async function seedUser(email) {
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const hash = await bcrypt.hash("pass12345", 4);
  return createUser(email, hash, "User");
}

async function addTxn(userId, opts) {
  const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
  return recordCreditTxn({ userId, refId: opts.refId || "seed", ...opts }, null);
}

// ─── getBalanceByBucket ───────────────────────────────────────────────────────

describe("getBalanceByBucket", () => {
  it("returns zeros for user with no transactions", async () => {
    const user = await seedUser("empty@example.com");
    const { getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const bal = await getBalanceByBucket(user.id);
    expect(bal).toEqual({ standard: 0, bonus: 0, resource: 0 });
  });

  it("sums amounts per bucket correctly", async () => {
    const user = await seedUser("bal@example.com");
    const future = new Date(Date.now() + 86400000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 10, refId: "r1" });
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 2, multiplier: 1.15, expiresAt: future, refId: "r2" });
    await addTxn(user.id, { type: "topup", bucket: "resource", amount: 5, refId: "r3" });

    const { getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const bal = await getBalanceByBucket(user.id);
    expect(bal.standard).toBeCloseTo(10);
    expect(bal.bonus).toBeCloseTo(2);
    expect(bal.resource).toBeCloseTo(5);
  });

  it("excludes expired bonus rows", async () => {
    const user = await seedUser("expired@example.com");
    const past = new Date(Date.now() - 1000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 5, expiresAt: past, refId: "r1" });
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 3, refId: "r2" });

    const { getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const bal = await getBalanceByBucket(user.id);
    expect(bal.bonus).toBe(0);
    expect(bal.standard).toBeCloseTo(3);
  });

  it("includes non-expiring bonus rows (expiresAt IS NULL)", async () => {
    const user = await seedUser("noexp@example.com");
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 4, refId: "r1" });
    const { getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const bal = await getBalanceByBucket(user.id);
    expect(bal.bonus).toBeCloseTo(4);
  });
});

// ─── deductFromPriorityBuckets — priority order ───────────────────────────────

describe("deductFromPriorityBuckets — priority order", () => {
  it("deducts resource before bonus before standard", async () => {
    const user = await seedUser("priority@example.com");
    const future = new Date(Date.now() + 86400000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 10, refId: "s" });
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 5, multiplier: 1.0, expiresAt: future, refId: "b" });
    await addTxn(user.id, { type: "topup", bucket: "resource", amount: 3, refId: "r" });

    const { deductFromPriorityBuckets, getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.transaction(() => deductFromPriorityBuckets(user.id, 2, "ref-prio", "test", db));

    const bal = await getBalanceByBucket(user.id);
    expect(bal.resource).toBeCloseTo(1);   // 3 - 2 = 1
    expect(bal.bonus).toBeCloseTo(5);      // untouched
    expect(bal.standard).toBeCloseTo(10);  // untouched
  });

  it("falls through to bonus when resource exhausted", async () => {
    const user = await seedUser("fallthrough@example.com");
    const future = new Date(Date.now() + 86400000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 10, refId: "s" });
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 5, multiplier: 1.0, expiresAt: future, refId: "b" });
    await addTxn(user.id, { type: "topup", bucket: "resource", amount: 2, refId: "r" });

    const { deductFromPriorityBuckets, getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.transaction(() => deductFromPriorityBuckets(user.id, 3, "ref-fall", "test", db));

    const bal = await getBalanceByBucket(user.id);
    expect(bal.resource).toBeCloseTo(0);
    expect(bal.bonus).toBeCloseTo(4);     // 5 - 1 = 4
    expect(bal.standard).toBeCloseTo(10); // untouched
  });

  it("falls through to standard when resource and bonus exhausted", async () => {
    const user = await seedUser("fallstd@example.com");
    const future = new Date(Date.now() + 86400000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "resource", amount: 1, refId: "r" });
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 1, multiplier: 1.0, expiresAt: future, refId: "b" });
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 10, refId: "s" });

    const { deductFromPriorityBuckets, getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.transaction(() => deductFromPriorityBuckets(user.id, 5, "ref-fallstd", "test", db));

    const bal = await getBalanceByBucket(user.id);
    expect(bal.resource).toBeCloseTo(0);
    expect(bal.bonus).toBeCloseTo(0);
    expect(bal.standard).toBeCloseTo(7); // 10 - (5 - 1 - 1) = 7
  });
});

// ─── deductFromPriorityBuckets — multiplier ───────────────────────────────────

describe("deductFromPriorityBuckets — multiplier", () => {
  it("applies multiplier when deducting from bonus bucket", async () => {
    const user = await seedUser("mult@example.com");
    const future = new Date(Date.now() + 86400000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 10, multiplier: 1.15, expiresAt: future, refId: "b" });

    const { deductFromPriorityBuckets } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.transaction(() => deductFromPriorityBuckets(user.id, 1, "ref-mult", "test", db));

    const row = db.get(
      `SELECT amount, multiplier, bucket FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction'`,
      [user.id]
    );
    expect(row.bucket).toBe("bonus");
    expect(row.amount).toBeCloseTo(-1.15);
    expect(row.multiplier).toBeCloseTo(1.15);

    const userRow = db.get(`SELECT creditsBalance FROM users WHERE id = ?`, [user.id]);
    expect(userRow.creditsBalance).toBeCloseTo(10 - 1.15);
  });

  it("uses multiplier=1 when no bonus credit history found", async () => {
    const user = await seedUser("nomult@example.com");
    const future = new Date(Date.now() + 86400000).toISOString();
    // Write bonus row directly without multiplier stored in DB (edge case)
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    // Manually insert a bonus row with no positive credit (unusual, but tests default)
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 10, refId: "s" });
    // Simulate having bonus balance but no positive history by direct insert
    const { v4: uuidv4 } = await import("uuid");
    const now2 = new Date().toISOString();
    db.run(
      `INSERT INTO creditTransactions(id, userId, type, bucket, amount, multiplier, expiresAt, refId, idempotencyKey, balanceAfter, note, createdAt)
       VALUES(?, ?, 'topup', 'bonus', 2, NULL, ?, 'direct', 'direct-key', 2, NULL, ?)`,
      [uuidv4(), user.id, future, now2]
    );
    db.run(`UPDATE users SET creditsBalance = creditsBalance + 2 WHERE id = ?`, [user.id]);

    const { deductFromPriorityBuckets } = await import("@/lib/db/repos/creditLedgerRepo.js");
    db.transaction(() => deductFromPriorityBuckets(user.id, 1, "ref-nomult", "test", db));

    const row = db.get(
      `SELECT amount, multiplier FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction' AND bucket = 'bonus'`,
      [user.id]
    );
    // multiplier defaults to 1 when mRow?.multiplier is null/undefined
    expect(row.multiplier).toBe(1);
    expect(row.amount).toBeCloseTo(-1);
  });
});

// ─── deductFromPriorityBuckets — expired bonus excluded ──────────────────────

describe("deductFromPriorityBuckets — expired bonus excluded", () => {
  it("skips expired bonus and falls through to standard", async () => {
    const user = await seedUser("expskip@example.com");
    const past = new Date(Date.now() - 1000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 10, expiresAt: past, refId: "b" });
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 10, refId: "s" });

    const { deductFromPriorityBuckets, getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.transaction(() => deductFromPriorityBuckets(user.id, 2, "ref-expskip", "test", db));

    const bal = await getBalanceByBucket(user.id);
    expect(bal.bonus).toBe(0);
    expect(bal.standard).toBeCloseTo(8);

    const rows = db.all(
      `SELECT bucket FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction'`,
      [user.id]
    );
    expect(rows.every(r => r.bucket === "standard")).toBe(true);
  });
});

// ─── standard-only user backward compat (AC5) ────────────────────────────────

describe("standard-only user backward compat (AC5)", () => {
  it("deducts from standard, multiplier=1, same as pre-2.20", async () => {
    const user = await seedUser("stdonly@example.com");
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 5, refId: "s" });

    const { deductFromPriorityBuckets, getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.transaction(() => deductFromPriorityBuckets(user.id, 1, "ref-std", "test", db));

    const bal = await getBalanceByBucket(user.id);
    expect(bal.standard).toBeCloseTo(4);
    expect(bal.bonus).toBe(0);
    expect(bal.resource).toBe(0);

    const row = db.get(
      `SELECT amount, multiplier, bucket FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction'`,
      [user.id]
    );
    expect(row.bucket).toBe("standard");
    expect(row.amount).toBeCloseTo(-1);
    expect(row.multiplier).toBe(1);
  });

  it("does NOT over-draw bonus when multiplier > 1 and cost > avail/multiplier (P1 regression)", async () => {
    const user = await seedUser("overdraw@example.com");
    const future = new Date(Date.now() + 86400000).toISOString();
    // bonus=1 credit, multiplier=2, standard=10 → bonus can cover at most 0.5 cost units
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 1, multiplier: 2, expiresAt: future, refId: "b" });
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 10, refId: "s" });

    const { deductFromPriorityBuckets, getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.transaction(() => deductFromPriorityBuckets(user.id, 2, "ref-overdraw", "test", db));

    const bal = await getBalanceByBucket(user.id);
    // Bonus should be drained to exactly 0, never negative
    expect(bal.bonus).toBeCloseTo(0, 5);
    // Bonus covered 0.5 cost units (avail / multiplier = 1 / 2); remaining 1.5 falls to standard
    expect(bal.standard).toBeCloseTo(8.5);

    // Verify ledger: bonus deduction = -1.0 (not -4), standard deduction = -1.5
    const bonusDed = db.get(
      `SELECT amount FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction' AND bucket = 'bonus'`,
      [user.id]
    );
    const stdDed = db.get(
      `SELECT amount FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction' AND bucket = 'standard'`,
      [user.id]
    );
    expect(bonusDed.amount).toBeCloseTo(-1);
    expect(stdDed.amount).toBeCloseTo(-1.5);
  });
});
