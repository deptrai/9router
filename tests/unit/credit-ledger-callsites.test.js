/**
 * credit-ledger-callsites.test.js — AC#5: 4 call-sites write correct ledger rows (Story 2.13)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ledger-cs-"));
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

async function makeUser(email = "cs@test.dev", credits = 0) {
  const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
  const user = await createUser(email, "hash", "CS Test");
  if (credits > 0) await updateUser(user.id, { creditsBalance: credits });
  return user;
}

describe("C1: addCredits wrapper → writes ledger row", () => {
  it("addCredits writes a ledger row with correct type", async () => {
    const user = await makeUser("ac@test.dev");
    const { addCredits } = await import("@/lib/db/repos/usersRepo.js");
    const { getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await addCredits(user.id, 10, null, { type: "admin_topup", refId: "admin-1" });
    const rows = await getLedgerByUser(user.id);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("admin_topup");
    expect(rows[0].amount).toBe(10);
    expect(rows[0].refId).toBe("admin-1");
  });

  it("addCredits default type is admin_topup", async () => {
    const user = await makeUser("ac2@test.dev");
    const { addCredits } = await import("@/lib/db/repos/usersRepo.js");
    const { getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await addCredits(user.id, 5);
    const rows = await getLedgerByUser(user.id);
    expect(rows[0].type).toBe("admin_topup");
  });
});

describe("C2: settlePayment → writes user_payment ledger row(s)", () => {
  it("payment without bonus → 1 standard ledger row", async () => {
    const user = await makeUser("settle@test.dev");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { settlePayment } = await import("@/lib/payment/settle.js");
    const { getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");

    const db = await getAdapter();
    const payId = "pay-test-001";
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO payments(id, userId, gatewayPaymentId, network, coin, amountExpected, status, bonusPercent, createdAt, updatedAt)
       VALUES(?, ?, ?, 'eth', 'USDC', 10, 'pending', 0, ?, ?)`,
      [payId, user.id, "gw-001", now, now]
    );

    await settlePayment({ id: payId, userId: user.id, bonusPercent: 0, network: "eth", coin: "USDC" }, { amountReceived: 10, txHash: "0xabc", confirmations: 1 });

    const rows = await getLedgerByUser(user.id);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("user_payment");
    expect(rows[0].bucket).toBe("standard");
    expect(rows[0].amount).toBe(10);
    const cached = (await getUserById(user.id)).creditsBalance;
    expect(cached).toBeCloseTo(10, 6);
  });

  it("payment with 10% bonus → 2 ledger rows (standard + bonus)", async () => {
    const user = await makeUser("settle2@test.dev");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { settlePayment } = await import("@/lib/payment/settle.js");
    const { getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");

    const db = await getAdapter();
    const payId = "pay-test-002";
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO payments(id, userId, gatewayPaymentId, network, coin, amountExpected, status, bonusPercent, createdAt, updatedAt)
       VALUES(?, ?, ?, 'eth', 'USDC', 10, 'pending', 10, ?, ?)`,
      [payId, user.id, "gw-002", now, now]
    );

    await settlePayment({ id: payId, userId: user.id, bonusPercent: 10, network: "eth", coin: "USDC" }, { amountReceived: 10, txHash: "0xdef", confirmations: 1 });

    const rows = await getLedgerByUser(user.id);
    expect(rows.length).toBe(2);
    const standard = rows.find(r => r.bucket === "standard");
    const bonus = rows.find(r => r.bucket === "bonus");
    expect(standard.amount).toBeCloseTo(10, 6);
    expect(bonus.amount).toBeCloseTo(1, 6);
    expect(bonus.expiresAt).toBeTruthy();
  });

  it("settlePayment idempotent: calling twice → same rows", async () => {
    const user = await makeUser("settle3@test.dev");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { settlePayment } = await import("@/lib/payment/settle.js");
    const { getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");

    const db = await getAdapter();
    const payId = "pay-test-003";
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO payments(id, userId, gatewayPaymentId, network, coin, amountExpected, status, bonusPercent, createdAt, updatedAt)
       VALUES(?, ?, ?, 'eth', 'USDC', 5, 'pending', 0, ?, ?)`,
      [payId, user.id, "gw-003", now, now]
    );

    await settlePayment({ id: payId, userId: user.id, bonusPercent: 0, network: "eth", coin: "USDC" }, { amountReceived: 5, txHash: "0xghi", confirmations: 1 });
    await settlePayment({ id: payId, userId: user.id, bonusPercent: 0, network: "eth", coin: "USDC" }, { amountReceived: 5, txHash: "0xghi", confirmations: 1 });

    const rows = await getLedgerByUser(user.id);
    expect(rows.length).toBe(1); // idempotent — only 1 row
  });
});

describe("C3: redeemGiftCode → writes gift_code ledger row", () => {
  it("gift redemption creates bonus bucket ledger row", async () => {
    const user = await makeUser("gift@test.dev");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { redeemGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const { getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");

    const db = await getAdapter();
    const gcId = "gc-test-001";
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO giftCodes(id, code, creditsAmount, isActive, redeemedCount, createdAt, updatedAt)
       VALUES(?, 'TESTCODE01', 15, 1, 0, ?, ?)`,
      [gcId, now, now]
    );

    await redeemGiftCode({ code: "TESTCODE01", userId: user.id });

    const rows = await getLedgerByUser(user.id);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("gift_code");
    expect(rows[0].bucket).toBe("bonus");
    expect(rows[0].amount).toBe(15);
    expect(rows[0].expiresAt).toBeTruthy(); // 14d expiry
    expect(rows[0].refId).toBe(gcId);
    expect(rows[0].idempotencyKey).toBe(`gift:${gcId}:${user.id}`);
  });
});

describe("C4: saveRequestUsage → writes usage_deduction ledger row", () => {
  it("usage deduction creates ledger row with negative amount", async () => {
    const user = await makeUser("usage@test.dev", 50); // start with 50 credits
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    const { getLedgerByUser } = await import("@/lib/db/repos/creditLedgerRepo.js");

    const key = await createApiKey("usage-key", "m1", user.id);

    await saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: key.key,
      endpoint: "/v1/chat/completions",
      status: "ok",
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const rows = await getLedgerByUser(user.id);
    const deduction = rows.find(r => r.type === "usage_deduction");
    expect(deduction).toBeTruthy();
    expect(deduction.amount).toBeLessThan(0);
    expect(deduction.bucket).toBe("standard");
  });

  it("usage deduction for legacy key (no userId) → no ledger row", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");

    const legacyKey = await createApiKey("legacy-usage", "m1"); // no userId
    await saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: legacyKey.key,
      endpoint: "/v1/chat/completions",
      status: "ok",
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const db = await getAdapter();
    const rows = db.all(`SELECT * FROM creditTransactions WHERE type = 'usage_deduction'`);
    expect(rows.length).toBe(0); // no deduction for legacy key
  });
});
