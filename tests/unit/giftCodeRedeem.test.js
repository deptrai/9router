// Story 2.10: User redeem API tests (AC3)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-redeem-"));
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

async function seedUser(email = "user@test.com", role = "user", balance = 0) {
  const bcrypt = await import("bcryptjs");
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const hash = await bcrypt.default.hash("pass", 4);
  const user = await createUser(email, hash, "Test");
  if (balance > 0) {
    const db = await getAdapter();
    db.run(`UPDATE users SET creditsBalance = ? WHERE id = ?`, [balance, user.id]);
  }
  return { ...user, role };
}

describe("POST /api/gift-codes/redeem", () => {
  it("verified user: happy path adds credits", async () => {
    const { createGiftCode, redeemGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");

    const user = await seedUser("redeem@test.com", "user", 0);
    const gc = await createGiftCode({ code: "REDEEM-TEST1", creditsAmount: 5 });

    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({
        userId: user.id,
        role: "user",
      }),
    }));

    vi.doMock("@/lib/auth/requireEmailVerified", () => ({
      requireEmailVerified: vi.fn().mockResolvedValue(true),
    }));

    const { POST } = await import("@/app/api/gift-codes/redeem/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ code: "REDEEM-TEST1" }),
    };
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.creditsAwarded).toBe(5);
    expect(data.newBalance).toBeCloseTo(5, 5);
  });

  it("unverified user → 403", async () => {
    const user = await seedUser("unverif@test.com", "user");

    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({
        userId: user.id,
        role: "user",
      }),
    }));

    vi.doMock("@/lib/auth/requireEmailVerified", () => ({
      requireEmailVerified: vi.fn().mockResolvedValue(false),
    }));

    const { POST } = await import("@/app/api/gift-codes/redeem/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ code: "ANYCODE" }),
    };
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(403);
    expect(data.error).toBe("Email verification required");
  });

  it("admin session → 403", async () => {
    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({
        userId: "admin-id",
        role: "admin",
      }),
    }));

    const { POST } = await import("@/app/api/gift-codes/redeem/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ code: "ANYCODE" }),
    };
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("no session → 401", async () => {
    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue(null),
    }));

    const { POST } = await import("@/app/api/gift-codes/redeem/route.js");
    const req = {
      cookies: { get: () => ({ value: "no-token" }) },
      json: async () => ({ code: "ANYCODE" }),
    };
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("inactive code → 400", async () => {
    const user = await seedUser("inactive@test.com", "user");

    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({
        userId: user.id,
        role: "user",
      }),
    }));

    vi.doMock("@/lib/auth/requireEmailVerified", () => ({
      requireEmailVerified: vi.fn().mockResolvedValue(true),
    }));

    vi.doMock("@/lib/db/repos/giftCodesRepo.js", async (importOriginal) => {
      const orig = await importOriginal();
      return {
        ...orig,
        redeemGiftCode: vi.fn().mockRejectedValue({
          code: "INACTIVE",
          message: "Gift code inactive",
        }),
      };
    });

    const { POST } = await import("@/app/api/gift-codes/redeem/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ code: "INACT-CODE" }),
    };
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("Gift code inactive");
  });

  it("expired code → 400", async () => {
    const user = await seedUser("expired@test.com", "user");

    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({
        userId: user.id,
        role: "user",
      }),
    }));

    vi.doMock("@/lib/auth/requireEmailVerified", () => ({
      requireEmailVerified: vi.fn().mockResolvedValue(true),
    }));

    vi.doMock("@/lib/db/repos/giftCodesRepo.js", async (importOriginal) => {
      const orig = await importOriginal();
      return {
        ...orig,
        redeemGiftCode: vi.fn().mockRejectedValue({
          code: "EXPIRED",
          message: "Gift code expired",
        }),
      };
    });

    const { POST } = await import("@/app/api/gift-codes/redeem/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ code: "EXPRD-CODE" }),
    };
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("Gift code expired");
  });

  it("exhausted code → 400", async () => {
    const user = await seedUser("exhausted@test.com", "user");

    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({
        userId: user.id,
        role: "user",
      }),
    }));

    vi.doMock("@/lib/auth/requireEmailVerified", () => ({
      requireEmailVerified: vi.fn().mockResolvedValue(true),
    }));

    vi.doMock("@/lib/db/repos/giftCodesRepo.js", async (importOriginal) => {
      const orig = await importOriginal();
      return {
        ...orig,
        redeemGiftCode: vi.fn().mockRejectedValue({
          code: "EXHAUSTED",
          message: "Gift code fully redeemed",
        }),
      };
    });

    const { POST } = await import("@/app/api/gift-codes/redeem/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ code: "EXHST-CODE" }),
    };
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("Gift code fully redeemed");
  });

  it("already redeemed by same user → 409", async () => {
    const user = await seedUser("dup@test.com", "user");

    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({
        userId: user.id,
        role: "user",
      }),
    }));

    vi.doMock("@/lib/auth/requireEmailVerified", () => ({
      requireEmailVerified: vi.fn().mockResolvedValue(true),
    }));

    vi.doMock("@/lib/db/repos/giftCodesRepo.js", async (importOriginal) => {
      const orig = await importOriginal();
      return {
        ...orig,
        redeemGiftCode: vi.fn().mockRejectedValue({
          code: "ALREADY_REDEEMED",
          message: "Gift code already redeemed",
        }),
      };
    });

    const { POST } = await import("@/app/api/gift-codes/redeem/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ code: "DUP-CODE" }),
    };
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toBe("Gift code already redeemed");
  });

  it("code not found → 404", async () => {
    const user = await seedUser("missing@test.com", "user");

    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({
        userId: user.id,
        role: "user",
      }),
    }));

    vi.doMock("@/lib/auth/requireEmailVerified", () => ({
      requireEmailVerified: vi.fn().mockResolvedValue(true),
    }));

    vi.doMock("@/lib/db/repos/giftCodesRepo.js", async (importOriginal) => {
      const orig = await importOriginal();
      return {
        ...orig,
        redeemGiftCode: vi.fn().mockRejectedValue({
          code: "NOT_FOUND",
          message: "Gift code not found",
        }),
      };
    });

    const { POST } = await import("@/app/api/gift-codes/redeem/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ code: "MISSING" }),
    };
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toBe("Gift code not found");
  });

  it("invalid code format → 400", async () => {
    const user = await seedUser("fmt@test.com", "user");

    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({
        userId: user.id,
        role: "user",
      }),
    }));

    vi.doMock("@/lib/auth/requireEmailVerified", () => ({
      requireEmailVerified: vi.fn().mockResolvedValue(true),
    }));

    vi.doMock("@/lib/db/repos/giftCodesRepo.js", async (importOriginal) => {
      const orig = await importOriginal();
      return {
        ...orig,
        redeemGiftCode: vi.fn().mockRejectedValue({
          code: "INVALID_CODE",
          message: "Invalid gift code format",
        }),
      };
    });

    const { POST } = await import("@/app/api/gift-codes/redeem/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ code: "ab" }),
    };
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("Invalid gift code format");
  });
});

describe("GET /api/gift-codes/redemptions", () => {
  it("user sees own redemptions", async () => {
    const user = { id: "user-1", role: "user" };

    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue({
        userId: user.id,
        role: "user",
      }),
    }));

    vi.doMock("@/lib/db/repos/giftCodesRepo", () => ({
      listGiftCodeRedemptions: vi.fn().mockResolvedValue([
        { id: "rdm-1", code: "LISTRDM1", userId: user.id, creditsAwarded: 3, redeemedAt: "2026-06-08T00:00:00.000Z" },
      ]),
    }));

    const { GET } = await import("@/app/api/gift-codes/redemptions/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      url: "http://localhost/api/gift-codes/redemptions",
    };
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(data.redemptions)).toBe(true);
    expect(data.redemptions.length).toBe(1);
  });

  it("non-logged-in → 401", async () => {
    vi.doMock("@/lib/auth/dashboardSession", () => ({
      getDashboardAuthSession: vi.fn().mockResolvedValue(null),
    }));

    const { GET } = await import("@/app/api/gift-codes/redemptions/route.js");
    const req = {
      cookies: { get: () => ({ value: "no-token" }) },
      url: "http://localhost/api/gift-codes/redemptions",
    };
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});
