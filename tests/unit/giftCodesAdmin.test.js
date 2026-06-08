// Story 2.10: Admin gift code API tests (AC2, AC5)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-admin-gc-"));
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

describe("POST /api/gift-codes — create (AC2)", () => {
  it("admin success: creates gift code", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
    }));

    const { POST } = await import("@/app/api/gift-codes/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ creditsAmount: 10, code: "ADMIN-TEST1" }),
    };
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.giftCode.code).toBe("ADMIN-TEST1");
    expect(data.giftCode.creditsAmount).toBe(10);
    expect(data.giftCode.isActive).toBe(true);
  });

  it("admin generates code when not provided", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
    }));

    const { POST } = await import("@/app/api/gift-codes/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ creditsAmount: 5 }),
    };
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.giftCode.code).toMatch(/^[A-Z0-9_-]{4,64}$/);
  });

  it("non-admin → 403", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue(null),
    }));

    const { POST } = await import("@/app/api/gift-codes/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ creditsAmount: 10 }),
    };
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("invalid creditsAmount → 400", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
    }));

    const { POST } = await import("@/app/api/gift-codes/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ creditsAmount: -5 }),
    };
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("invalid maxRedemptions → 400", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
    }));

    const { POST } = await import("@/app/api/gift-codes/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ creditsAmount: 5, maxRedemptions: -1 }),
    };
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("invalid expiresAt → 400", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
    }));

    const { POST } = await import("@/app/api/gift-codes/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ creditsAmount: 5, expiresAt: "invalid-date" }),
    };
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("past expiresAt → 400", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
    }));

    const { POST } = await import("@/app/api/gift-codes/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ creditsAmount: 5, expiresAt: "2020-01-01T00:00:00.000Z" }),
    };
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("invalid code format → 400", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
    }));

    const { POST } = await import("@/app/api/gift-codes/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ creditsAmount: 5, code: "ab" }),
    };
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/gift-codes — list (AC2)", () => {
  it("admin lists gift codes", async () => {
    const { createGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    await createGiftCode({ code: "LIST1", creditsAmount: 5 });
    await createGiftCode({ code: "LIST2", creditsAmount: 10 });

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
    }));

    const { GET } = await import("@/app/api/gift-codes/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      url: "http://localhost/api/gift-codes",
    };
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.giftCodes.length).toBeGreaterThanOrEqual(2);
  });

  it("non-admin → 403", async () => {
    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue(null),
    }));

    const { GET } = await import("@/app/api/gift-codes/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      url: "http://localhost/api/gift-codes",
    };
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/gift-codes/[id] — disable (AC2)", () => {
  it("admin disables gift code", async () => {
    const { createGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ code: "DISABLE-TEST", creditsAmount: 5 });

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
    }));

    const { PATCH } = await import("@/app/api/gift-codes/[id]/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
      json: async () => ({ isActive: false }),
    };
    const res = await PATCH(req, { params: Promise.resolve({ id: gc.id }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.giftCode.isActive).toBe(false);
  });

  it("non-admin → 403", async () => {
    const { createGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ code: "GUARD-DISABLE", creditsAmount: 5 });

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue(null),
    }));

    const { PATCH } = await import("@/app/api/gift-codes/[id]/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
      json: async () => ({ isActive: false }),
    };
    const res = await PATCH(req, { params: Promise.resolve({ id: gc.id }) });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/gift-codes/[id] — soft delete (AC2)", () => {
  it("admin soft-deletes gift code", async () => {
    const { createGiftCode, getGiftCodeById } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ code: "DELETE-TEST", creditsAmount: 5 });

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-id", role: "admin" }),
    }));

    const { DELETE } = await import("@/app/api/gift-codes/[id]/route.js");
    const req = {
      cookies: { get: () => ({ value: "admin-token" }) },
    };
    const res = await DELETE(req, { params: Promise.resolve({ id: gc.id }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);

    const updated = await getGiftCodeById(gc.id);
    expect(updated.isActive).toBe(false);
  });

  it("non-admin → 403", async () => {
    const { createGiftCode } = await import("@/lib/db/repos/giftCodesRepo.js");
    const gc = await createGiftCode({ code: "GUARD-DELETE", creditsAmount: 5 });

    vi.doMock("@/lib/auth/requireRole", () => ({
      requireAdmin: vi.fn().mockResolvedValue(null),
    }));

    const { DELETE } = await import("@/app/api/gift-codes/[id]/route.js");
    const req = {
      cookies: { get: () => ({ value: "user-token" }) },
    };
    const res = await DELETE(req, { params: Promise.resolve({ id: gc.id }) });
    expect(res.status).toBe(403);
  });
});
