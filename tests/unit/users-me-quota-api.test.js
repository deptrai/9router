import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let mockSession = null;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-meQuota-"));
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

describe("GET /api/users/me/quota", () => {
  it("returns snapshot for user role", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const user = await createUser("quota@test.dev", await bcrypt.hash("pass1234", 10), "Quota");
    mockSession = { role: "user", userId: user.id };

    const { GET } = await import("@/app/api/users/me/quota/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      source: "credit",
      planName: null,
      rpm: 0,
      rpmUsed: 0,
      creditsBalance: 0,
      allowCreditOverflow: false,
    });
    expect(data.quota5h.limit).toBe(0);
  });

  it("returns 403 for non-user", async () => {
    mockSession = { role: "admin", userId: "x" };
    const { GET } = await import("@/app/api/users/me/quota/route.js");
    const res = await GET();
    expect(res.status).toBe(403);
  });
});
