import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let mockSession = null;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-meLedger-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  mockSession = null;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve({ get: vi.fn(() => ({ value: "mock-token" })) })),
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: vi.fn(async () => mockSession),
}));

describe("GET /api/users/me/ledger", () => {
  it("returns only session user ledger with pagination and type filter", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
    const u1 = await createUser("ledger1@test.dev", await bcrypt.hash("pass1234", 10), "L1");
    const u2 = await createUser("ledger2@test.dev", await bcrypt.hash("pass1234", 10), "L2");
    mockSession = { role: "user", userId: u1.id };

    await recordCreditTxn({ userId: u1.id, type: "admin_topup", refId: "admin:test-u1", amount: 10, note: "top" });
    await recordCreditTxn({ userId: u1.id, type: "usage_deduction", refId: "usage:test-u1", amount: -3, note: "use" });
    await recordCreditTxn({ userId: u2.id, type: "admin_topup", refId: "admin:test-u2", amount: 99, note: "other" });

    const { GET } = await import("@/app/api/users/me/ledger/route.js");
    const res = await GET({ url: "http://localhost/api/users/me/ledger?limit=1&offset=0&type=usage_deduction" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0].userId).toBe(u1.id);
    expect(data.transactions[0].type).toBe("usage_deduction");
  });

  it("returns 403 for admin", async () => {
    mockSession = { role: "admin", userId: "x" };
    const { GET } = await import("@/app/api/users/me/ledger/route.js");
    const res = await GET({ url: "http://localhost/api/users/me/ledger" });
    expect(res.status).toBe(403);
  });
});
