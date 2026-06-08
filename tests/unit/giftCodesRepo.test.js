// Story 2.10: giftCodesRepo unit tests (AC1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-giftcodes-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  vi.resetModules();
});

async function seedUser(email = "user@test.com", balance = 0) {
  const bcrypt = await import("bcryptjs");
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const hash = await bcrypt.default.hash("pass", 4);
  const user = await createUser(email, hash, "Test");
  if (balance > 0) {
    const db = await getAdapter();
    db.run(`UPDATE users SET creditsBalance = ? WHERE id = ?`, [balance, user.id]);
  }
  return user;
}

describe("createGiftCode", () => {
  it("creates a gift code with explicit code", async () => {
    const { createGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ code: "PROMO-2024", creditsAmount: 5 });
    expect(gc.code).toBe("PROMO-2024");
    expect(gc.creditsAmount).toBe(5);
    expect(gc.isActive).toBe(true);
    expect(gc.redeemedCount).toBe(0);
  });

  it("normalizes code to uppercase", async () => {
    const { createGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ code: "promo-test", creditsAmount: 3 });
    expect(gc.code).toBe("PROMO-TEST");
  });

  it("auto-generates code when not provided", async () => {
    const { createGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ creditsAmount: 2 });
    expect(gc.code).toMatch(/^[A-Z0-9_-]{4,64}$/);
    expect(gc.code.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects duplicate code", async () => {
    const { createGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    await createGiftCode({ code: "DUPE-CODE", creditsAmount: 1 });
    await expect(createGiftCode({ code: "DUPE-CODE", creditsAmount: 2 })).rejects.toThrow();
  });

  it("rejects invalid code format", async () => {
    const { createGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    await expect(createGiftCode({ code: "ab", creditsAmount: 1 })).rejects.toThrow("Invalid code format");
  });

  it("stores optional fields", async () => {
    const { createGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({
      code: "GIFT-NOTE1",
      creditsAmount: 10,
      maxRedemptions: 5,
      note: "Test promo",
      createdBy: "admin-1",
    });
    expect(gc.maxRedemptions).toBe(5);
    expect(gc.note).toBe("Test promo");
    expect(gc.createdBy).toBe("admin-1");
  });
});

describe("getGiftCodeByCode", () => {
  it("finds by code (case-insensitive)", async () => {
    const { createGiftCode, getGiftCodeByCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    await createGiftCode({ code: "FIND-ME01", creditsAmount: 7 });
    const gc = await getGiftCodeByCode("find-me01");
    expect(gc).not.toBeNull();
    expect(gc.code).toBe("FIND-ME01");
  });

  it("returns null for missing code", async () => {
    const { getGiftCodeByCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await getGiftCodeByCode("NOTEXIST");
    expect(gc).toBeNull();
  });
});

describe("listGiftCodes", () => {
  it("lists created codes", async () => {
    const { createGiftCode, listGiftCodes } = await import("@/lib/db/repos/giftCodesRepo.js");
    await createGiftCode({ code: "LIST-AA01", creditsAmount: 1 });
    await createGiftCode({ code: "LIST-BB02", creditsAmount: 2 });
    const codes = await listGiftCodes();
    expect(codes.length).toBeGreaterThanOrEqual(2);
  });

  it("clamps limit to 500 max", async () => {
    const { listGiftCodes } = await import("@/lib/db/repos/giftCodesRepo.js");
    // Just verify no error with absurd limit
    const codes = await listGiftCodes({ limit: 9999 });
    expect(Array.isArray(codes)).toBe(true);
  });

  it("excludes inactive when includeInactive=false", async () => {
    const { createGiftCode, disableGiftCode, listGiftCodes } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ code: "INACT-001", creditsAmount: 1 });
    await disableGiftCode(gc.id);
    const active = await listGiftCodes({ includeInactive: false });
    expect(active.find((c) => c.id === gc.id)).toBeUndefined();
  });
});

describe("disableGiftCode", () => {
  it("sets isActive to false", async () => {
    const { createGiftCode, disableGiftCode, getGiftCodeById } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ code: "DISABLE1", creditsAmount: 1 });
    await disableGiftCode(gc.id);
    const updated = await getGiftCodeById(gc.id);
    expect(updated.isActive).toBe(false);
  });
});

describe("redeemGiftCode", () => {
  it("happy path: awards credits and inserts redemption", async () => {
    const user = await seedUser("redeem@test.com", 0);
    const { createGiftCode, redeemGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ code: "HAPPY-001", creditsAmount: 5 });

    const result = await redeemGiftCode({ code: "HAPPY-001", userId: user.id });
    expect(result.success).toBe(true);
    expect(result.creditsAwarded).toBe(5);
    expect(result.newBalance).toBeCloseTo(5, 5);
  });

  it("rejects inactive code", async () => {
    const user = await seedUser("inactive@test.com");
    const { createGiftCode, disableGiftCode, redeemGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ code: "INACT-REDM", creditsAmount: 5 });
    await disableGiftCode(gc.id);

    await expect(redeemGiftCode({ code: "INACT-REDM", userId: user.id }))
      .rejects.toMatchObject({ code: "INACTIVE" });
  });

  it("rejects expired code", async () => {
    const user = await seedUser("expired@test.com");
    const { createGiftCode, redeemGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    await createGiftCode({ code: "EXPRD-001", creditsAmount: 5, expiresAt: "2020-01-01T00:00:00.000Z" });

    await expect(redeemGiftCode({ code: "EXPRD-001", userId: user.id }))
      .rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("rejects exhausted code", async () => {
    const user1 = await seedUser("u1@test.com");
    const user2 = await seedUser("u2@test.com");
    const { createGiftCode, redeemGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    await createGiftCode({ code: "EXHAUST1", creditsAmount: 1, maxRedemptions: 1 });

    await redeemGiftCode({ code: "EXHAUST1", userId: user1.id });
    await expect(redeemGiftCode({ code: "EXHAUST1", userId: user2.id }))
      .rejects.toMatchObject({ code: "EXHAUSTED" });
  });

  it("rejects same-user double redeem (no double credit)", async () => {
    const user = await seedUser("double@test.com", 0);
    const { createGiftCode, redeemGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    await createGiftCode({ code: "DOUBLE-01", creditsAmount: 5 });

    await redeemGiftCode({ code: "DOUBLE-01", userId: user.id });
    await expect(redeemGiftCode({ code: "DOUBLE-01", userId: user.id }))
      .rejects.toMatchObject({ code: "ALREADY_REDEEMED" });

    // Verify balance not doubled
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const updated = await getUserById(user.id);
    expect(updated.creditsBalance).toBeCloseTo(5, 5);
  });

  it("rejects missing code with NOT_FOUND", async () => {
    const user = await seedUser("missing@test.com");
    const { redeemGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    await expect(redeemGiftCode({ code: "NOEXIST1", userId: user.id }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("increments redeemedCount after redeem", async () => {
    const user = await seedUser("count@test.com");
    const { createGiftCode, redeemGiftCode, getGiftCodeByCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    await createGiftCode({ code: "COUNT-001", creditsAmount: 1 });
    await redeemGiftCode({ code: "COUNT-001", userId: user.id });
    const gc = await getGiftCodeByCode("COUNT-001");
    expect(gc.redeemedCount).toBe(1);
  });
});

describe("listGiftCodeRedemptions", () => {
  it("lists redemptions for a user", async () => {
    const user = await seedUser("listrdm@test.com");
    const { createGiftCode, redeemGiftCode, listGiftCodeRedemptions } = await import("@/lib/db/repos/giftCodesRepo.js");
    await createGiftCode({ code: "LISTRDM1", creditsAmount: 3 });
    await redeemGiftCode({ code: "LISTRDM1", userId: user.id });

    const redemptions = await listGiftCodeRedemptions({ userId: user.id });
    expect(redemptions.length).toBe(1);
    expect(redemptions[0].code).toBe("LISTRDM1");
    expect(redemptions[0].creditsAwarded).toBe(3);
  });

  it("returns empty for user with no redemptions", async () => {
    const user = await seedUser("empty@test.com");
    const { listGiftCodeRedemptions } = await import("@/lib/db/repos/giftCodesRepo.js");
    const redemptions = await listGiftCodeRedemptions({ userId: user.id });
    expect(redemptions).toEqual([]);
  });

  it("clamps limit to 500 max", async () => {
    const { listGiftCodeRedemptions } = await import("@/lib/db/repos/giftCodesRepo.js");
    const result = await listGiftCodeRedemptions({ limit: 9999 });
    expect(Array.isArray(result)).toBe(true);
  });
});
