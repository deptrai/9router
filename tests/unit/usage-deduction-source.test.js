/**
 * usage-deduction-source.test.js — Conditional deduction by billingSource (Story 2.14, E.3, AC#6)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-deduc-"));
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

async function seedUserAndKey(email = "deduct@test.dev", balance = 50) {
  const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
  const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  const user = await createUser(email, "hash", "Deduct");
  await updateUser(user.id, { creditsBalance: balance });
  const key = await createApiKey("deduct-key", "m1", user.id);
  return { user, key };
}

describe("saveRequestUsage — conditional deduction by billingSource (AC#6)", () => {
  it("billingSource=plan → NO ledger row written, balance unchanged", async () => {
    const { user, key } = await seedUserAndKey("plan@test.dev", 50);
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    const { rebuildBalanceFromLedger } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");

    await saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: key.key,
      endpoint: "/v1/chat/completions",
      status: "ok",
      tokens: { prompt_tokens: 1000, completion_tokens: 500 },
      billingSource: "plan",
    });

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const ledgerRows = db.all(`SELECT * FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction'`, [user.id]);
    expect(ledgerRows.length).toBe(0);

    // Balance stays at 50 (seeded directly, not via ledger)
    const updated = await getUserById(user.id);
    expect(updated.creditsBalance).toBe(50);
  });

  it("billingSource=credit → ledger row written, balance decreases", async () => {
    const { user, key } = await seedUserAndKey("credit@test.dev", 50);
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");

    await saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: key.key,
      endpoint: "/v1/chat/completions",
      status: "ok",
      tokens: { prompt_tokens: 1000, completion_tokens: 500 },
      billingSource: "credit",
    });

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const ledgerRows = db.all(`SELECT * FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction'`, [user.id]);
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].amount).toBeLessThan(0);
  });

  it("billingSource=overflow → ledger row written with [overflow] note", async () => {
    const { user, key } = await seedUserAndKey("overflow@test.dev", 50);
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");

    await saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: key.key,
      endpoint: "/v1/chat/completions",
      status: "ok",
      tokens: { prompt_tokens: 1000, completion_tokens: 500 },
      billingSource: "overflow",
    });

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const ledgerRows = db.all(`SELECT * FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction'`, [user.id]);
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].note).toContain("[overflow]");
  });

  it("billingSource=undefined (legacy/no plan path) → deduction still occurs (regression 2.4)", async () => {
    const { user, key } = await seedUserAndKey("legacy@test.dev", 50);
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");

    await saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: key.key,
      endpoint: "/v1/chat/completions",
      status: "ok",
      tokens: { prompt_tokens: 1000, completion_tokens: 500 },
      // billingSource intentionally omitted
    });

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const ledgerRows = db.all(`SELECT * FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction'`, [user.id]);
    expect(ledgerRows.length).toBe(1); // deduction happens (legacy behaviour preserved)
  });

  it("billingSource=plan, rebuildBalanceFromLedger === cache balance (BP-2 maintained)", async () => {
    const { user, key } = await seedUserAndKey("planrebuild@test.dev", 0);
    const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
    // Give user 20 credits via ledger
    await recordCreditTxn({ userId: user.id, type: "admin_topup", refId: "admin:planrebuild", amount: 20 });

    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    await saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: key.key,
      endpoint: "/v1/chat/completions",
      status: "ok",
      tokens: { prompt_tokens: 1000, completion_tokens: 500 },
      billingSource: "plan",
    });

    const { rebuildBalanceFromLedger } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const rebuilt = await rebuildBalanceFromLedger(user.id);
    const cached = (await getUserById(user.id)).creditsBalance;
    expect(rebuilt).toBeCloseTo(cached, 6);
    expect(rebuilt).toBeCloseTo(20, 6); // no deduction happened
  });
});

// Regression: the streaming usage path goes through logUsage() (open-sse/utils/stream.js),
// NOT saveRequestUsage() directly. logUsage must forward billingSource or plan users get
// charged on streaming responses (the dominant path). These tests exercise that entry point.
describe("logUsage — forwards billingSource to deduction (streaming path, AC#3/#6)", () => {
  it("logUsage billingSource=plan → NO ledger deduction (plan user on streaming response)", async () => {
    const { user, key } = await seedUserAndKey("logusage-plan@test.dev", 50);
    const { logUsage } = await import("open-sse/utils/usageTracking.js");

    logUsage("anthropic", { prompt_tokens: 1000, completion_tokens: 500 }, "claude-sonnet-4-6", "conn-1", key.key, "plan");
    // logUsage fires saveRequestUsage().catch() async — await a tick for it to flush
    await new Promise((r) => setTimeout(r, 50));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const ledgerRows = db.all(`SELECT * FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction'`, [user.id]);
    expect(ledgerRows.length).toBe(0);
  });

  it("logUsage billingSource=credit → ledger deduction occurs", async () => {
    const { user, key } = await seedUserAndKey("logusage-credit@test.dev", 50);
    const { logUsage } = await import("open-sse/utils/usageTracking.js");

    logUsage("anthropic", { prompt_tokens: 1000, completion_tokens: 500 }, "claude-sonnet-4-6", "conn-1", key.key, "credit");
    await new Promise((r) => setTimeout(r, 50));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const ledgerRows = db.all(`SELECT * FROM creditTransactions WHERE userId = ? AND type = 'usage_deduction'`, [user.id]);
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].amount).toBeLessThan(0);
  });
});
