import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let mockSession = null;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mePlanPurchaseApi-"));
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

function req(body) {
  return { json: async () => body };
}

async function seed({ credits = 20, priceCredits = 10 } = {}) {
  const { createUser } = await import("@/lib/db/repos/usersRepo.js");
  const { createPlan } = await import("@/lib/db/repos/plansRepo.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const user = await createUser(`buy-${crypto.randomUUID()}@test.dev`, await bcrypt.hash("pass1234", 10), "Buyer");
  const plan = await createPlan({ name: `plan-${crypto.randomUUID().slice(0, 8)}`, priceCredits, durationDays: 30 });
  (await getAdapter()).run(`UPDATE users SET creditsBalance = ? WHERE id = ?`, [credits, user.id]);
  mockSession = { role: "user", userId: user.id };
  return { user, plan };
}

describe("POST /api/users/me/plan/purchase", () => {
  it("purchases plan for session user", async () => {
    const { plan } = await seed();
    const { POST } = await import("@/app/api/users/me/plan/purchase/route.js");

    const res = await POST(req({ planId: plan.id, idempotencyKey: "api-1", userId: "evil", priceCredits: 0 }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.action).toBe("buy");
    expect(data.user.creditsBalance).toBe(10);
    expect(data.user.planId).toBe(plan.id);
    expect(data.transaction.type).toBe("plan_activation");
  });

  it("returns idempotent response on retry without double charge", async () => {
    const { plan, user } = await seed();
    const { POST } = await import("@/app/api/users/me/plan/purchase/route.js");

    const first = await POST(req({ planId: plan.id, idempotencyKey: "retry-1" }));
    const firstData = await first.json();
    const second = await POST(req({ planId: plan.id, idempotencyKey: "retry-1" }));
    const secondData = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondData.idempotent).toBe(true);
    expect(secondData.user.creditsBalance).toBe(firstData.user.creditsBalance);
    expect(secondData.user.planExpiresAt).toBe(firstData.user.planExpiresAt);
    expect(secondData.transaction.idempotencyKey).toBe(firstData.transaction.idempotencyKey);
    const { getAdapter } = await import("@/lib/db/driver.js");
    const ledger = (await getAdapter()).all(`SELECT * FROM creditTransactions WHERE userId = ? AND type = 'plan_activation'`, [user.id]);
    expect(ledger).toHaveLength(1);
  });

  it("maps validation, missing plan, insufficient credits, and admin", async () => {
    const { plan } = await seed({ credits: 1, priceCredits: 10 });
    const { POST } = await import("@/app/api/users/me/plan/purchase/route.js");

    expect((await POST(req({ planId: plan.id, idempotencyKey: "" }))).status).toBe(400);
    expect((await POST(req({ planId: "missing", idempotencyKey: "missing" }))).status).toBe(404);
    const poor = await POST(req({ planId: plan.id, idempotencyKey: "poor" }));
    expect(poor.status).toBe(402);
    expect(await poor.json()).toMatchObject({ error: "Insufficient credits", requiredCredits: 10, creditsBalance: 1, topupHref: "/dashboard/credits" });

    mockSession = { role: "admin", userId: "admin" };
    expect((await POST(req({ planId: plan.id, idempotencyKey: "admin" }))).status).toBe(403);
  });
});
