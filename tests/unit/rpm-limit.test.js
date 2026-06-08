import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-rpmLimit-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function setup({ rpm, hasPlan = true } = {}) {
  const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
  const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  const { createPlan } = await import("@/lib/db/repos/plansRepo.js");

  const user = await createUser("rpm@test.dev", "hash", "RPM User");
  let plan = null;
  if (hasPlan) {
    plan = await createPlan({ name: "test-plan", rpm: rpm ?? 2, quota5h: 1000000, quotaWeekly: 10000000 });
    await updateUser(user.id, { planId: plan.id });
  }
  const key = await createApiKey("rpm-key-1", "machine-1", user.id);
  return { user, plan, key };
}

describe("checkRpmLimit", () => {
  it("no apiKey → allowed", async () => {
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    expect((await checkRpmLimit(null)).allowed).toBe(true);
    expect((await checkRpmLimit("")).allowed).toBe(true);
  });

  it("legacy key (no userId) → allowed", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    const k = await createApiKey("legacy-key", "machine-1"); // no userId
    expect((await checkRpmLimit(k.key)).allowed).toBe(true);
  });

  it("user with no plan (source=credit) → allowed", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    const user = await createUser("noplan@test.dev", "hash", "No Plan");
    const key = await createApiKey("noplan-key", "machine-1", user.id);
    expect((await checkRpmLimit(key.key)).allowed).toBe(true);
  });

  it("plan rpm=0 (unlimited) → allowed", async () => {
    const { key } = await setup({ rpm: 0 });
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    expect((await checkRpmLimit(key.key)).allowed).toBe(true);
  });

  it("under limit → allowed and increments count", async () => {
    const { key } = await setup({ rpm: 3 });
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    const now = Date.now();
    const r1 = await checkRpmLimit(key.key, now);
    expect(r1.allowed).toBe(true);
    const r2 = await checkRpmLimit(key.key, now + 100);
    expect(r2.allowed).toBe(true);
  });

  it("at limit → denied with 429 fields", async () => {
    const { key } = await setup({ rpm: 2 });
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    const now = Date.now();
    await checkRpmLimit(key.key, now);       // count=1
    await checkRpmLimit(key.key, now + 100); // count=2
    const r3 = await checkRpmLimit(key.key, now + 200); // count=2 >= rpm=2 → deny
    expect(r3.allowed).toBe(false);
    expect(r3.rpm).toBe(2);
    expect(r3.count).toBe(2);
    expect(r3.planName).toBe("test-plan");
    expect(r3.retryAfter).toBeTruthy();
    expect(r3.retryAfterHuman).toMatch(/reset after \d+s/);
  });

  it("multi-key same user: pooled RPM (AC#3)", async () => {
    const { user, plan } = await setup({ rpm: 1 });
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    const key2 = await createApiKey("rpm-key-2", "machine-1", user.id);
    const now = Date.now();
    // Resolve the actual stored key tokens (createApiKey stores an auto-generated key, not the name).
    const { getApiKeysByUser } = await import("@/lib/db/repos/apiKeysRepo.js");
    const keys = await getApiKeysByUser(user.id);
    const k1 = keys.find(k => k.name === "rpm-key-1");
    const k2 = keys.find(k => k.name === "rpm-key-2");
    const ra = await checkRpmLimit(k1.key, now);          // count=1, allowed (consumes the 1 slot)
    expect(ra.allowed).toBe(true);
    const rb = await checkRpmLimit(k2.key, now + 100);    // pooled by user: count=1 >= rpm=1, denied
    expect(rb.allowed).toBe(false);
  });

  it("window resets after 1m — allowed again", async () => {
    const { key } = await setup({ rpm: 1 });
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    const now = Date.now();
    const r1 = await checkRpmLimit(key.key, now);
    expect(r1.allowed).toBe(true);
    const r2 = await checkRpmLimit(key.key, now + 100);
    expect(r2.allowed).toBe(false);
    // 61s later — window reset
    const r3 = await checkRpmLimit(key.key, now + 61_000);
    expect(r3.allowed).toBe(true);
  });

  it("update plan rpm → new limit applies immediately (AC#7)", async () => {
    const { key, plan } = await setup({ rpm: 1 });
    const { updatePlan } = await import("@/lib/db/repos/plansRepo.js");
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    const now = Date.now();
    await checkRpmLimit(key.key, now); // count=1, allowed
    // Would be denied at rpm=1, but upgrade to rpm=5
    await updatePlan(plan.id, { rpm: 5 });
    const r = await checkRpmLimit(key.key, now + 100);
    expect(r.allowed).toBe(true); // count=2 < 5
  });

  it("fail-open: resolveUserLimits throws → allowed", async () => {
    const { key } = await setup({ rpm: 2 });
    vi.doMock("@/lib/quota/resolvePlan.js", () => ({
      resolveUserLimits: vi.fn(async () => { throw new Error("resolver error"); }),
    }));
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    expect((await checkRpmLimit(key.key)).allowed).toBe(true);
    vi.doUnmock("@/lib/quota/resolvePlan.js");
  });

  it("fail-open: getRpmState throws → allowed", async () => {
    const { key } = await setup({ rpm: 2 });
    vi.doMock("@/lib/db/repos/quotaRepo.js", async () => {
      const actual = await vi.importActual("@/lib/db/repos/quotaRepo.js");
      return { ...actual, getRpmState: vi.fn(async () => { throw new Error("kv error"); }) };
    });
    const { checkRpmLimit } = await import("@/lib/quota/rpmLimit.js");
    expect((await checkRpmLimit(key.key)).allowed).toBe(true);
    vi.doUnmock("@/lib/db/repos/quotaRepo.js");
  });
});
