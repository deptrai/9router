import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-userPlanAdminApi-"));
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

function mockAdmin(session = { userId: "admin-id", role: "admin" }) {
  vi.doMock("@/lib/auth/requireRole", () => ({
    requireAdmin: vi.fn().mockResolvedValue(session),
    getSessionRole: vi.fn().mockResolvedValue({ session, role: session?.role ?? "user" }),
  }));
}

function req(body) {
  return {
    cookies: { get: () => ({ value: "token" }) },
    json: async () => body,
  };
}

async function seedUserAndPlan(planData = {}) {
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
  const user = await createUser(`u-${Date.now()}@test.dev`, "hash", "Test User");
  const plan = await createPlan({ name: `plan-${Date.now()}`, rpm: 9, ...planData });
  return { user, plan };
}

describe("PATCH /api/users/[id]/plan", () => {
  it("assigns active plan with ISO expiry and returns plan summary", async () => {
    mockAdmin();
    const { user, plan } = await seedUserAndPlan({ displayName: "Plan A" });
    const expiry = new Date(Date.now() + 86400000).toISOString();
    const { PATCH } = await import("@/app/api/users/[id]/plan/route.js");

    const res = await PATCH(req({ planId: plan.id, planExpiresAt: expiry }), { params: { id: user.id } });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.user.planId).toBe(plan.id);
    expect(data.user.planExpiresAt).toBe(expiry);
    expect(data.user.plan).toEqual({ id: plan.id, name: plan.name, displayName: "Plan A" });
    expect(data.user.passwordHash).toBeUndefined();
  });

  it("removes plan without changing credits", async () => {
    mockAdmin();
    const { user, plan } = await seedUserAndPlan();
    const { updateUser, getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`UPDATE users SET creditsBalance = ? WHERE id = ?`, [12.5, user.id]);
    await updateUser(user.id, { planId: plan.id, planExpiresAt: new Date(Date.now() + 86400000).toISOString() });
    const { PATCH } = await import("@/app/api/users/[id]/plan/route.js");

    const res = await PATCH(req({ planId: null, planExpiresAt: null }), { params: { id: user.id } });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.user.planId).toBeNull();
    expect(data.user.planExpiresAt).toBeNull();
    expect((await getUserById(user.id)).creditsBalance).toBe(12.5);
  });

  it("rejects inactive/missing plan and invalid expiry", async () => {
    mockAdmin();
    const { user, plan } = await seedUserAndPlan({ isActive: false });
    const { PATCH } = await import("@/app/api/users/[id]/plan/route.js");

    expect((await PATCH(req({ planId: plan.id, planExpiresAt: null }), { params: { id: user.id } })).status).toBe(400);
    expect((await PATCH(req({ planId: "missing", planExpiresAt: null }), { params: { id: user.id } })).status).toBe(400);
    expect((await PATCH(req({ planId: null, planExpiresAt: "nope" }), { params: { id: user.id } })).status).toBe(400);
    expect((await PATCH(req({ planId: null, planExpiresAt: "2026-02-30" }), { params: { id: user.id } })).status).toBe(400);
  });

  it("non-admin receives 403", async () => {
    mockAdmin(null);
    const { user, plan } = await seedUserAndPlan();
    const { PATCH } = await import("@/app/api/users/[id]/plan/route.js");
    expect((await PATCH(req({ planId: plan.id, planExpiresAt: null }), { params: { id: user.id } })).status).toBe(403);
  });

  it("resolveUserLimits reflects assigned plan and inactive plan fallback", async () => {
    mockAdmin();
    const { user, plan } = await seedUserAndPlan({ rpm: 33 });
    const { PATCH } = await import("@/app/api/users/[id]/plan/route.js");
    const { deletePlan } = await import("@/lib/db/repos/plansRepo.js");
    const { resolveUserLimits } = await import("@/lib/quota/resolvePlan.js");

    await PATCH(req({ planId: plan.id, planExpiresAt: null }), { params: { id: user.id } });
    expect((await resolveUserLimits(user.id)).rpm).toBe(33);
    await deletePlan(plan.id);
    expect((await resolveUserLimits(user.id)).source).toBe("credit");
  });
});
