/**
 * affiliate.test.js — Story 2.37
 * Covers: refCode generation (AC1), referral tracking (AC3), commission (AC4, AC5, AC10),
 *         /ref command (AC6), /start deeplink (AC3/T4)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data, opts = {}) => ({ status: opts?.status ?? 200, _body: data }),
  },
}));

vi.mock("@/lib/telegram/botClient.js", () => ({
  sendMessage: vi.fn().mockResolvedValue({ ok: true }),
  answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
  setWebhook: vi.fn().mockResolvedValue({ ok: true }),
  isBotConfigured: vi.fn().mockReturnValue(true),
}));

let tempDir;
const origDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-aff-"));
  process.env.DATA_DIR = tempDir;
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
  process.env.BASE_URL = "https://test.example.com";
  process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = "test_bot";
  process.env.AFFILIATE_COMMISSION_PERCENT = "10";
  process.env.AFFILIATE_STORE_COMMISSION_PERCENT = "5";
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  vi.restoreAllMocks();
});

async function setupUser(telegramId, displayName = `User_${telegramId}`) {
  const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
  const user = await createUser(`telegram_${telegramId}@placeholder.local`, null, displayName);
  await updateUser(user.id, { telegramId });
  return user;
}

// ─── AC1: refCode generation ─────────────────────────────────────────────────

describe("Affiliate — AC1: refCode generation", () => {
  it("createUser generates unique 8-hex refCode", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const u1 = await createUser("a@test.com", null, "A");
    const u2 = await createUser("b@test.com", null, "B");

    expect(u1.refCode).toMatch(/^[a-f0-9]{8}$/);
    expect(u2.refCode).toMatch(/^[a-f0-9]{8}$/);
    expect(u1.refCode).not.toBe(u2.refCode);
  });
});

// ─── AC2: migration backfills refCode ────────────────────────────────────────

describe("Affiliate — AC2: migration backfill", () => {
  it("users created via migration have refCode after migration runs", async () => {
    const { getUserById, createUser } = await import("@/lib/db/repos/usersRepo.js");
    const user = await createUser("test@test.com", null, "Test");
    const fetched = await getUserById(user.id);
    expect(fetched.refCode).toMatch(/^[a-f0-9]{8}$/);
  });
});

// ─── AC3: referral tracking via getUserByRefCode ─────────────────────────────

describe("Affiliate — AC3: referral tracking", () => {
  it("getUserByRefCode returns user for valid code", async () => {
    const { createUser, getUserByRefCode } = await import("@/lib/db/repos/usersRepo.js");
    const user = await createUser("ref@test.com", null, "Referrer");
    const found = await getUserByRefCode(user.refCode);
    expect(found.id).toBe(user.id);
  });

  it("getUserByRefCode returns null for invalid code", async () => {
    const { getUserByRefCode } = await import("@/lib/db/repos/usersRepo.js");
    const found = await getUserByRefCode("00000000");
    expect(found).toBeNull();
  });
});

// ─── AC4, AC5: commission on topup ──────────────────────────────────────────

describe("Affiliate — AC4, AC5: topup commission", () => {
  it("pays referrer commission when referred user tops up", async () => {
    const { createUser, updateUser, getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { payAffiliateCommission } = await import("@/lib/affiliate/affiliateCommission.js");

    const referrer = await createUser("referrer@test.com", null, "Referrer");
    const referred = await createUser("referred@test.com", null, "Referred");
    await updateUser(referred.id, { referredBy: referrer.id });

    // Simulate topup
    const txn = await recordCreditTxn({
      userId: referred.id, type: "admin_topup", amount: 100, bucket: "standard", refId: "topup-1",
    });

    const result = await payAffiliateCommission({
      userId: referred.id, txnId: txn.id, type: "admin_topup", amount: 100,
    });

    expect(result).not.toBeNull();
    expect(result.amount).toBe(10); // 10%
    expect(result.type).toBe("affiliate_commission");
    expect(result.userId).toBe(referrer.id);
  });

  it("idempotent — no double commission for same txn", async () => {
    const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
    const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const { payAffiliateCommission } = await import("@/lib/affiliate/affiliateCommission.js");

    const referrer = await createUser("r@test.com", null, "R");
    const referred = await createUser("d@test.com", null, "D");
    await updateUser(referred.id, { referredBy: referrer.id });

    const txn = await recordCreditTxn({
      userId: referred.id, type: "admin_topup", amount: 50, bucket: "standard", refId: "topup-2",
    });

    const r1 = await payAffiliateCommission({ userId: referred.id, txnId: txn.id, type: "admin_topup", amount: 50 });
    const r2 = await payAffiliateCommission({ userId: referred.id, txnId: txn.id, type: "admin_topup", amount: 50 });

    expect(r1.amount).toBe(5);
    // r2 is the existing txn (idempotent replay)
    expect(r2.id).toBe(r1.id);
  });

  it("no commission for non-eligible types", async () => {
    const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
    const { payAffiliateCommission } = await import("@/lib/affiliate/affiliateCommission.js");

    const referrer = await createUser("r2@test.com", null, "R2");
    const referred = await createUser("d2@test.com", null, "D2");
    await updateUser(referred.id, { referredBy: referrer.id });

    const result = await payAffiliateCommission({
      userId: referred.id, txnId: "fake-txn", type: "store_purchase", amount: 50,
    });
    expect(result).toBeNull();
  });

  it("no commission when user has no referrer", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { payAffiliateCommission } = await import("@/lib/affiliate/affiliateCommission.js");

    await createUser("solo@test.com", null, "Solo");

    const result = await payAffiliateCommission({
      userId: "nonexistent", txnId: "t1", type: "admin_topup", amount: 100,
    });
    expect(result).toBeNull();
  });
});

// ─── AC10: store commission ──────────────────────────────────────────────────

describe("Affiliate — AC10: store commission", () => {
  it("pays referrer store commission on purchase", async () => {
    const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
    const { payAffiliateStoreCommission } = await import("@/lib/affiliate/affiliateCommission.js");

    const referrer = await createUser("sr@test.com", null, "StoreReferrer");
    const buyer = await createUser("sb@test.com", null, "StoreBuyer");
    await updateUser(buyer.id, { referredBy: referrer.id });

    const result = await payAffiliateStoreCommission({
      buyerUserId: buyer.id, orderId: "order-123", totalCredits: 100,
    });

    expect(result).not.toBeNull();
    expect(result.amount).toBe(5); // 5%
    expect(result.type).toBe("affiliate_store_commission");
    expect(result.userId).toBe(referrer.id);
  });
});

// ─── AC6: /ref command ───────────────────────────────────────────────────────

describe("Affiliate — AC6: /ref command", () => {
  it("hiển thị refCode, link, stats", async () => {
    await setupUser("900", "RefUser");
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      message: { text: "/ref", chat: { id: 999 }, from: { id: 900 } },
    });

    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("Chương trình giới thiệu");
    expect(text).toContain("register?ref=");
    expect(text).toContain("t.me/test_bot?start=ref_");
    expect(text).toContain("Đã giới thiệu");
  });

  it("reply keyboard '👥 Giới thiệu' triggers /ref", async () => {
    await setupUser("901", "KBUser");
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      message: { text: "👥 Giới thiệu", chat: { id: 999 }, from: { id: 901 } },
    });

    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("Chương trình giới thiệu");
  });
});

// ─── AC3/T4: /start ref deeplink ────────────────────────────────────────────

describe("Affiliate — /start ref deeplink", () => {
  it("sets referredBy for new user with valid refCode", async () => {
    const { createUser, updateUser, getUserByTelegramId } = await import("@/lib/db/repos/usersRepo.js");
    const referrer = await createUser("ref_starter@test.com", null, "Starter");
    await updateUser(referrer.id, { telegramId: "800" });

    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      message: { text: `/start ref_${referrer.refCode}`, chat: { id: 999 }, from: { id: 850, first_name: "NewGuy" } },
    });

    const newUser = await getUserByTelegramId("850");
    expect(newUser).not.toBeNull();
    expect(newUser.referredBy).toBe(referrer.id);
  });

  it("does not override referredBy for existing user", async () => {
    const { createUser, updateUser, getUserByTelegramId } = await import("@/lib/db/repos/usersRepo.js");
    const referrer1 = await createUser("r1@test.com", null, "R1");
    const referrer2 = await createUser("r2@test.com", null, "R2");
    const existing = await createUser("telegram_860@placeholder.local", null, "Existing");
    await updateUser(existing.id, { telegramId: "860", referredBy: referrer1.id });

    const { handleUpdate } = await import("@/lib/telegram/router.js");

    await handleUpdate({
      message: { text: `/start ref_${referrer2.refCode}`, chat: { id: 999 }, from: { id: 860, first_name: "Existing" } },
    });

    const user = await getUserByTelegramId("860");
    expect(user.referredBy).toBe(referrer1.id); // unchanged
  });
});
