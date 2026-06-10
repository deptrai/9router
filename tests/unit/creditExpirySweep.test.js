import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-creditSweep-"));
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

// ─── reconcileUserBalance ─────────────────────────────────────────────────────

describe("reconcileUserBalance", () => {
  it("syncs cache down to effective balance after bonus expires", async () => {
    const user = await seedUser("recon@example.com");
    const past = new Date(Date.now() - 1000).toISOString();
    // standard 10 (no expiry) + bonus 5 (already expired)
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 10, refId: "s" });
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 5, expiresAt: past, refId: "b" });

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    // Cache is inflated: recordCreditTxn added 10 + 5 = 15 (no expiry filter on cache)
    const before = db.get(`SELECT creditsBalance FROM users WHERE id = ?`, [user.id]);
    expect(before.creditsBalance).toBeCloseTo(15);

    const { reconcileUserBalance } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const fresh = await reconcileUserBalance(user.id);

    // Effective balance excludes expired bonus → 10
    expect(fresh).toBeCloseTo(10);
    const after = db.get(`SELECT creditsBalance FROM users WHERE id = ?`, [user.id]);
    expect(after.creditsBalance).toBeCloseTo(10);
  });

  it("is idempotent — repeated calls keep the same value", async () => {
    const user = await seedUser("idem@example.com");
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 7, refId: "s" });

    const { reconcileUserBalance } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const a = await reconcileUserBalance(user.id);
    const b = await reconcileUserBalance(user.id);
    expect(a).toBeCloseTo(7);
    expect(b).toBeCloseTo(7);
  });
});

// ─── runExpirySweep ───────────────────────────────────────────────────────────

describe("runExpirySweep", () => {
  it("reconciles users whose credit expired in the window", async () => {
    const user = await seedUser("sweep@example.com");
    const past = new Date(Date.now() - 1000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 8, refId: "s" });
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 4, expiresAt: past, refId: "b" });

    const { runExpirySweep } = await import("@/lib/billing/creditExpirySweep.js");
    const result = await runExpirySweep();

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const after = db.get(`SELECT creditsBalance FROM users WHERE id = ?`, [user.id]);
    expect(after.creditsBalance).toBeCloseTo(8); // expired bonus reconciled out
  });

  it("advances cursor only when no failures (cold start full-scans from epoch)", async () => {
    // Seed a user with an old-expired bonus, then run sweep — should still catch it
    const user = await seedUser("coldstart@example.com");
    const oldPast = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h ago (> old 25h lookback)
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 6, refId: "s" });
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 3, expiresAt: oldPast, refId: "b" });

    const { runExpirySweep } = await import("@/lib/billing/creditExpirySweep.js");
    const result = await runExpirySweep();

    // P3 fix: epoch cold-start catches the 48h-old expiry that a 25h lookback would miss
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const after = db.get(`SELECT creditsBalance FROM users WHERE id = ?`, [user.id]);
    expect(after.creditsBalance).toBeCloseTo(6);
  });

  it("second sweep with no new expiry is a no-op on balance", async () => {
    const user = await seedUser("twice@example.com");
    const past = new Date(Date.now() - 1000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 5, refId: "s" });
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 2, expiresAt: past, refId: "b" });

    const { runExpirySweep } = await import("@/lib/billing/creditExpirySweep.js");
    await runExpirySweep();
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const after1 = db.get(`SELECT creditsBalance FROM users WHERE id = ?`, [user.id]);
    await runExpirySweep();
    const after2 = db.get(`SELECT creditsBalance FROM users WHERE id = ?`, [user.id]);
    expect(after2.creditsBalance).toBeCloseTo(after1.creditsBalance);
  });
});

// ─── AC5 regression: expired credit not deductible ────────────────────────────

describe("AC5 — expired credit excluded from balance/deduction", () => {
  it("getBalanceByBucket excludes expired bonus", async () => {
    const user = await seedUser("ac5bal@example.com");
    const past = new Date(Date.now() - 1000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 9, expiresAt: past, refId: "b" });

    const { getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const bal = await getBalanceByBucket(user.id);
    expect(bal.bonus).toBe(0);
  });

  it("deductFromPriorityBuckets skips expired bonus, draws from standard", async () => {
    const user = await seedUser("ac5ded@example.com");
    const past = new Date(Date.now() - 1000).toISOString();
    await addTxn(user.id, { type: "topup", bucket: "bonus", amount: 9, expiresAt: past, refId: "b" });
    await addTxn(user.id, { type: "topup", bucket: "standard", amount: 9, refId: "s" });

    const { deductFromPriorityBuckets, getBalanceByBucket } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.transaction(() => deductFromPriorityBuckets(user.id, 2, "ref-ac5", "test", db));

    const bal = await getBalanceByBucket(user.id);
    expect(bal.bonus).toBe(0);
    expect(bal.standard).toBeCloseTo(7);
  });
});
