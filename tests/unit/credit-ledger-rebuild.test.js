/**
 * credit-ledger-rebuild.test.js — BP-2: rebuildBalanceFromLedger (Story 2.13)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ledger-rebuild-"));
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

async function makeUser(email = "rebuild@test.dev") {
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  return createUser(email, "hash", "Rebuild Test");
}

describe("rebuildBalanceFromLedger — BP-2", () => {
  it("empty ledger → 0", async () => {
    const user = await makeUser();
    const { rebuildBalanceFromLedger } = await import("@/lib/db/repos/creditLedgerRepo.js");
    expect(await rebuildBalanceFromLedger(user.id)).toBe(0);
  });

  it("after series of txns: rebuild === cache (BP-2 invariant)", async () => {
    const user = await makeUser("rb2@test.dev");
    const { recordCreditTxn, rebuildBalanceFromLedger } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    await recordCreditTxn({ userId: user.id, type: "admin_topup", refId: "test:rb2-topup", amount: 50 });
    await recordCreditTxn({ userId: user.id, type: "user_payment", refId: "pay:rb2", amount: 20 });
    await recordCreditTxn({ userId: user.id, type: "usage_deduction", refId: "usage:rb2", amount: -15 });
    await recordCreditTxn({ userId: user.id, type: "gift_code", bucket: "bonus", refId: "gift:rb2", amount: 10 });
    const rebuilt = await rebuildBalanceFromLedger(user.id);
    const cached = (await getUserById(user.id)).creditsBalance;
    expect(rebuilt).toBeCloseTo(cached, 6);
    expect(rebuilt).toBeCloseTo(65, 6);
  });

  it("reversal: after reverseTxn, rebuild reflects net balance", async () => {
    const user = await makeUser("rb3@test.dev");
    const { recordCreditTxn, reverseTxn, rebuildBalanceFromLedger } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const txn = await recordCreditTxn({ userId: user.id, type: "admin_topup", refId: "test:rb3-topup", amount: 30 });
    await reverseTxn(txn.id, "refund");
    const rebuilt = await rebuildBalanceFromLedger(user.id);
    const cached = (await getUserById(user.id)).creditsBalance;
    expect(rebuilt).toBeCloseTo(0, 6);
    expect(rebuilt).toBeCloseTo(cached, 6);
  });

  it("expired bonus NOT included in rebuild balance", async () => {
    const user = await makeUser("rb4@test.dev");
    const { recordCreditTxn, rebuildBalanceFromLedger } = await import("@/lib/db/repos/creditLedgerRepo.js");
    // standard credit (permanent)
    await recordCreditTxn({ userId: user.id, type: "admin_topup", bucket: "standard", refId: "test:rb4-topup", amount: 20 });
    // expired bonus (past expiry)
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    await recordCreditTxn({ userId: user.id, type: "gift_code", bucket: "bonus", refId: "gift:rb4", amount: 10, expiresAt: pastExpiry });
    const rebuilt = await rebuildBalanceFromLedger(user.id);
    // Only the standard 20 counts — expired bonus excluded
    expect(rebuilt).toBeCloseTo(20, 6);
  });

  it("non-expired bonus IS included in rebuild balance", async () => {
    const user = await makeUser("rb5@test.dev");
    const { recordCreditTxn, rebuildBalanceFromLedger } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await recordCreditTxn({ userId: user.id, type: "admin_topup", bucket: "standard", refId: "test:rb5-topup", amount: 10 });
    const futureExpiry = new Date(Date.now() + 86400_000).toISOString();
    await recordCreditTxn({ userId: user.id, type: "gift_code", bucket: "bonus", refId: "gift:rb5", amount: 5, expiresAt: futureExpiry });
    const rebuilt = await rebuildBalanceFromLedger(user.id);
    expect(rebuilt).toBeCloseTo(15, 6);
  });

  it("rebuild after many random txns matches cache", async () => {
    const user = await makeUser("rb6@test.dev");
    const { recordCreditTxn, rebuildBalanceFromLedger } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    // Simulate random topup/deduction sequence
    const amounts = [100, -10, 25, -5, 50, -30, 15];
    for (const amt of amounts) {
      await recordCreditTxn({ userId: user.id, type: amt > 0 ? "admin_topup" : "usage_deduction", refId: `random:${amt}:${Math.random()}`, amount: amt });
    }
    const rebuilt = await rebuildBalanceFromLedger(user.id);
    const cached = (await getUserById(user.id)).creditsBalance;
    expect(rebuilt).toBeCloseTo(cached, 6);
    expect(rebuilt).toBeCloseTo(145, 6);
  });
});
