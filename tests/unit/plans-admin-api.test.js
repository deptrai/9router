import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-plansAdminApi-"));
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

describe("/api/plans admin CRUD", () => {
  it("GET returns active and inactive plans", async () => {
    mockAdmin();
    const { createPlan, deletePlan } = await import("@/lib/db/repos/plansRepo.js");
    const active = await createPlan({ name: "visible-active", sortOrder: 99 });
    const inactive = await createPlan({ name: "visible-inactive", sortOrder: 100 });
    await deletePlan(inactive.id);

    const { GET } = await import("@/app/api/plans/route.js");
    const res = await GET(req());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.plans.map((p) => p.id)).toContain(active.id);
    expect(data.plans.map((p) => p.id)).toContain(inactive.id);
  });

  it("POST validates and creates a plan", async () => {
    mockAdmin();
    const { POST } = await import("@/app/api/plans/route.js");
    const res = await POST(req({
      name: "team_pro",
      displayName: "Team Pro",
      rpm: 10,
      quota5h: 0,
      quotaWeekly: 1000,
      perModelLimits: { "gpt-test": { q5h: 10, qWeekly: 20 } },
      isActive: true,
      sortOrder: 9,
    }));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.plan.name).toBe("team_pro");
    expect(data.plan.quota5h).toBe(0);
  });

  it("POST rejects empty/duplicate/negative/non-object perModelLimits", async () => {
    mockAdmin();
    const { POST } = await import("@/app/api/plans/route.js");
    expect((await POST(req({ name: "", rpm: 1 }))).status).toBe(400);
    expect((await POST(req({ name: "bad-neg", rpm: -1 }))).status).toBe(400);
    expect((await POST(req({ name: "bad-null", rpm: null }))).status).toBe(400);
    expect((await POST(req({ name: "bad-string", quota5h: "" }))).status).toBe(400);
    expect((await POST(req({ name: "bad-array", quotaWeekly: [1] }))).status).toBe(400);
    expect((await POST(req({ name: "bad-bool", sortOrder: false }))).status).toBe(400);
    expect((await POST(req({ name: "bad-limits", perModelLimits: [] }))).status).toBe(400);
    const first = await POST(req({ name: "unique-plan" }));
    expect(first.status).toBe(201);
    expect((await POST(req({ name: "unique-plan" }))).status).toBeGreaterThanOrEqual(400);
  });

  it("PATCH updates, DELETE soft-disables, PATCH reactivates", async () => {
    mockAdmin();
    const { createPlan, getPlanById } = await import("@/lib/db/repos/plansRepo.js");
    const plan = await createPlan({ name: "editable", rpm: 1 });
    const route = await import("@/app/api/plans/[id]/route.js");

    const patched = await route.PATCH(req({ rpm: 20, quotaWeekly: 0 }), { params: { id: plan.id } });
    expect(patched.status).toBe(200);
    expect((await patched.json()).plan.rpm).toBe(20);

    const deleted = await route.DELETE(req(), { params: { id: plan.id } });
    expect(deleted.status).toBe(200);
    expect((await getPlanById(plan.id)).isActive).toBe(false);

    const reactivated = await route.PATCH(req({ isActive: true }), { params: { id: plan.id } });
    expect(reactivated.status).toBe(200);
    expect((await getPlanById(plan.id)).isActive).toBe(true);
  });

  it("non-admin receives 403", async () => {
    mockAdmin(null);
    const { GET, POST } = await import("@/app/api/plans/route.js");
    expect((await GET(req())).status).toBe(403);
    expect((await POST(req({ name: "x" }))).status).toBe(403);
  });

  it("dashboard plans page labels per-model limits as enforced", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("/Users/luisphan/Documents/9router/src/app/(dashboard)/dashboard/plans/page.js", "utf8");
    expect(content).not.toContain("not enforced yet");
    expect(content).toContain("canonical model");
    expect(content).toContain("enforced");
  });
});
