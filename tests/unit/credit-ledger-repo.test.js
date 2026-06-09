/**
 * credit-ledger-repo.test.js — BP-1..5 + BP-7 (Story 2.13)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ledger-"));
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

async function makeUser(email = "ledger@test.dev") {
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  return createUser(email, "hash", "Ledger Test");
}

describe("creditLedgerRepo — BP-1: append-only (no update/delete)", () => {
  it("recordCreditTxn inserts a new row (never updates)", async () => {
    const user = await makeUser();
    const { recordCreditTxn, getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await recordCreditTxn({ userId: user.id, type: "admin_topup", refId: "test:topup-10", amount: 10 });
    const rows = await getLedgerByUser(user.id);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("admin_topup");
    expect(rows[0].amount).toBe(10);
  });

  it("reverseTxn creates new reversal row — original row unchanged (BP-1)", async () => {
    const user = await makeUser("rev@test.dev");
    const { recordCreditTxn, reverseTxn, getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const orig = await recordCreditTxn({ userId: user.id, type: "admin_topup", refId: "test:topup-20", amount: 20 });
    await reverseTxn(orig.id, "test reversal");
    const rows = await getLedgerByUser(user.id);
    expect(rows.length).toBe(2);
    const origRow = rows.find(r => r.id === orig.id);
    const reversalRow = rows.find(r => r.type === "reversal");
    expect(origRow.amount).toBe(20); // unchanged
    expect(reversalRow.amount).toBe(-20);
    expect(reversalRow.refId).toBe(orig.id);
  });

  it("cannot reverse a reversal row (BP-1 guard)", async () => {
    const user = await makeUser("rev2@test.dev");
    const { recordCreditTxn, reverseTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const orig = await recordCreditTxn({ userId: user.id, type: "admin_topup", refId: "test:topup-5", amount: 5 });
    const rev = await reverseTxn(orig.id, "first reversal");
    await expect(reverseTxn(rev.id, "reverse a reversal")).rejects.toThrow(/cannot reverse a reversal/i);
  });

  it("reverseTxn idempotent: reversing twice returns existing reversal", async () => {
    const user = await makeUser("rev3@test.dev");
    const { recordCreditTxn, reverseTxn, getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const orig = await recordCreditTxn({ userId: user.id, type: "admin_topup", refId: "test:topup-8", amount: 8 });
    await reverseTxn(orig.id, "reversal 1");
    await reverseTxn(orig.id, "reversal 2 (duplicate)");
    const rows = await getLedgerByUser(user.id);
    expect(rows.filter(r => r.type === "reversal").length).toBe(1); // only one
  });
});

describe("creditLedgerRepo — BP-3: provenance (type + refId)", () => {
  it("every row has type", async () => {
    const user = await makeUser("prov@test.dev");
    const { recordCreditTxn, getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await recordCreditTxn({ userId: user.id, type: "user_payment", refId: "pay-1", amount: 5 });
    const rows = await getLedgerByUser(user.id);
    expect(rows[0].type).toBe("user_payment");
    expect(rows[0].refId).toBe("pay-1");
  });

  it("rejects non-migration rows without refId", async () => {
    const user = await makeUser("prov-missing-ref@test.dev");
    const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await expect(recordCreditTxn({ userId: user.id, type: "admin_topup", amount: 5 })).rejects.toThrow(/refId is required/i);
  });

  it("rejects blank type and non-finite amount", async () => {
    const user = await makeUser("prov-invalid@test.dev");
    const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await expect(recordCreditTxn({ userId: user.id, type: "", refId: "admin:x", amount: 5 })).rejects.toThrow(/type is required/i);
    await expect(recordCreditTxn({ userId: user.id, type: "admin_topup", refId: "admin:x", amount: Number.NaN })).rejects.toThrow(/finite number/i);
  });
});

describe("creditLedgerRepo — BP-5: nested transaction failures are synchronous", () => {
  it("invalid nested ledger write throws inside caller transaction and rolls back", async () => {
    const user = await makeUser("nested-sync@test.dev");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { recordCreditTxn, getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const db = await getAdapter();

    expect(() => db.transaction(() => {
      db.run(`UPDATE users SET creditsBalance = creditsBalance + 10 WHERE id = ?`, [user.id]);
      recordCreditTxn({ userId: user.id, type: "admin_topup", amount: 10 }, db);
    })).toThrow(/refId is required/i);

    expect((await getUserById(user.id)).creditsBalance).toBe(0);
    expect(await getLedgerByUser(user.id)).toHaveLength(0);
  });
});

describe("creditLedgerRepo — BP-4: idempotency", () => {
  it("same idempotencyKey twice → only 1 row, balance unchanged on 2nd call", async () => {
    const user = await makeUser("idm@test.dev");
    const { recordCreditTxn, getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    await recordCreditTxn({ userId: user.id, type: "user_payment", refId: "pay:abc", amount: 10, idempotencyKey: "pay:abc:standard" });
    await recordCreditTxn({ userId: user.id, type: "user_payment", refId: "pay:abc", amount: 10, idempotencyKey: "pay:abc:standard" });
    const rows = await getLedgerByUser(user.id);
    expect(rows.length).toBe(1);
    const updated = await getUserById(user.id);
    expect(updated.creditsBalance).toBe(10); // not 20
  });
});

describe("creditLedgerRepo — BP-5: atomicity (ledger + cache in same transaction)", () => {
  it("balance cache matches ledger row balanceAfter after recordCreditTxn", async () => {
    const user = await makeUser("atom@test.dev");
    const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const txn = await recordCreditTxn({ userId: user.id, type: "admin_topup", refId: "test:topup-15", amount: 15 });
    const updated = await getUserById(user.id);
    expect(txn.balanceAfter).toBe(15);
    expect(updated.creditsBalance).toBe(15);
  });

  it("multiple transactions accumulate correctly", async () => {
    const user = await makeUser("atom2@test.dev");
    const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    await recordCreditTxn({ userId: user.id, type: "admin_topup", refId: "test:topup-20b", amount: 20 });
    await recordCreditTxn({ userId: user.id, type: "usage_deduction", refId: "usage:test-5", amount: -5 });
    const updated = await getUserById(user.id);
    expect(updated.creditsBalance).toBe(15);
  });
});

describe("creditLedgerRepo — BP-7: bucket / expiresAt / multiplier", () => {
  it("bucket stored and retrieved correctly", async () => {
    const user = await makeUser("bucket@test.dev");
    const { recordCreditTxn, getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await recordCreditTxn({ userId: user.id, type: "gift_code", bucket: "bonus", refId: "gift:test-3", amount: 3 });
    const rows = await getLedgerByUser(user.id);
    expect(rows[0].bucket).toBe("bonus");
  });

  it("expiresAt stored and retrievable", async () => {
    const user = await makeUser("exp@test.dev");
    const { recordCreditTxn, getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const expiry = new Date(Date.now() + 14 * 86400_000).toISOString();
    await recordCreditTxn({ userId: user.id, type: "gift_code", bucket: "bonus", refId: "gift:test-exp", amount: 5, expiresAt: expiry });
    const rows = await getLedgerByUser(user.id);
    expect(rows[0].expiresAt).toBe(expiry);
  });

  it("multiplier stored and retrievable", async () => {
    const user = await makeUser("mult@test.dev");
    const { recordCreditTxn, getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await recordCreditTxn({ userId: user.id, type: "user_payment", bucket: "bonus", refId: "pay:bonus-2", amount: 2, multiplier: 1.3 });
    const rows = await getLedgerByUser(user.id);
    expect(rows[0].multiplier).toBe(1.3);
  });

  it("getLedgerByUser filter by bucket", async () => {
    const user = await makeUser("filt@test.dev");
    const { recordCreditTxn, getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await recordCreditTxn({ userId: user.id, type: "admin_topup", bucket: "standard", refId: "test:topup-10c", amount: 10 });
    await recordCreditTxn({ userId: user.id, type: "gift_code", bucket: "bonus", refId: "gift:test-5b", amount: 5 });
    const bonus = await getLedgerByUser(user.id, { bucket: "bonus" });
    expect(bonus.length).toBe(1);
    expect(bonus[0].bucket).toBe("bonus");
  });

  it("exports available from barrel", async () => {
    const db = await import("@/lib/db/index.js");
    expect(typeof db.recordCreditTxn).toBe("function");
    expect(typeof db.getLedgerByUser).toBe("function");
    expect(typeof db.rebuildBalanceFromLedger).toBe("function");
    expect(typeof db.reverseTxn).toBe("function");
  });
});
