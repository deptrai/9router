import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let mockSession = null;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mePlans-"));
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
  vi.resetModules();
});

vi.mock("next/headers", () => ({ cookies: vi.fn(() => Promise.resolve({ get: vi.fn(() => ({ value: "mock-token" })) })) }));
vi.mock("@/lib/auth/dashboardSession", () => ({ getDashboardAuthSession: vi.fn(async () => mockSession) }));

describe("GET /api/users/me/plans", () => {
  it("returns active catalog with affordability/action and no userCount", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createPlan, deletePlan } = await import("@/lib/db/repos/plansRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const user = await createUser("plans@test.dev", await bcrypt.hash("pass1234", 10), "Plans");
    const active = await createPlan({ name: "buyable", priceCredits: 10, durationDays: 30, sortOrder: 99 });
    const inactive = await createPlan({ name: "hidden", priceCredits: 1, sortOrder: 100 });
    await deletePlan(inactive.id);
    (await getAdapter()).run(`UPDATE users SET creditsBalance = ? WHERE id = ?`, [12, user.id]);
    mockSession = { role: "user", userId: user.id };

    const { GET } = await import("@/app/api/users/me/plans/route.js");
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.creditsBalance).toBe(12);
    expect(data.plans.map((p) => p.id)).toContain(active.id);
    expect(data.plans.map((p) => p.id)).not.toContain(inactive.id);
    expect(data.plans.find((p) => p.id === active.id)).toMatchObject({ priceCredits: 10, durationDays: 30, canAfford: true, action: "buy" });
    expect(data.plans.find((p) => p.id === active.id).userCount).toBeUndefined();
  });

  it("infers renew for same active plan and change for different active plan", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const user = await createUser("plans-renew@test.dev", await bcrypt.hash("pass1234", 10), "Plans");
    const current = await createPlan({ name: "current", priceCredits: 10, durationDays: 30, sortOrder: 1 });
    const other = await createPlan({ name: "other", priceCredits: 15, durationDays: 30, sortOrder: 2 });
    (await getAdapter()).run(
      `UPDATE users SET creditsBalance = ?, planId = ?, planExpiresAt = ? WHERE id = ?`,
      [20, current.id, "2026-07-01T00:00:00.000Z", user.id]
    );
    mockSession = { role: "user", userId: user.id };

    const { GET } = await import("@/app/api/users/me/plans/route.js");
    const data = await (await GET()).json();

    expect(data.plans.find((p) => p.id === current.id)).toMatchObject({ action: "renew", canAfford: true });
    expect(data.plans.find((p) => p.id === other.id)).toMatchObject({ action: "change", canAfford: true });
  });

  it("returns 403 for admin", async () => {
    mockSession = { role: "admin", userId: "admin" };
    const { GET } = await import("@/app/api/users/me/plans/route.js");
    expect((await GET()).status).toBe(403);
  });
});
