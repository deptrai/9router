// Story 2.3 Task 2+3: keys routes role-aware + ownership tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let mockSession = null;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-keysRoutes-"));
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = "test-secret-keys";
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
  delete process.env.JWT_SECRET;
});

// Mock next/headers cookies
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve({
    set: vi.fn(),
    get: vi.fn((name) => name === "auth_token" ? { value: "mock-token" } : undefined),
    delete: vi.fn(),
  })),
}));

// Mock getDashboardAuthSession
vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: vi.fn(async () => mockSession),
  setDashboardAuthCookie: vi.fn(),
  verifyDashboardAuthToken: vi.fn(async () => true),
}));

// Mock getConsistentMachineId
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "test-machine-id"),
}));

describe("GET /api/keys", () => {
  it("user role → returns only own keys", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    await createApiKey("my-key", "test-machine-id", "user-A");
    await createApiKey("other-key", "test-machine-id", "user-B");
    await createApiKey("admin-key", "test-machine-id"); // no userId

    mockSession = { role: "user", userId: "user-A", email: "a@example.com" };

    const { GET } = await import("@/app/api/keys/route.js");
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.keys.length).toBe(1);
    expect(data.keys[0].name).toBe("my-key");
  });

  it("admin role → returns all keys", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    await createApiKey("user-key", "test-machine-id", "user-A");
    await createApiKey("admin-key", "test-machine-id"); // no userId

    mockSession = { role: "admin" };

    const { GET } = await import("@/app/api/keys/route.js");
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.keys.length).toBe(2);
  });

  it("legacy token (no role) → returns all keys", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    await createApiKey("legacy-key", "test-machine-id");

    mockSession = { authenticated: true }; // no role field

    const { GET } = await import("@/app/api/keys/route.js");
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.keys.length).toBe(1);
  });
});

describe("POST /api/keys", () => {
  function makeRequest(body) {
    return { json: () => Promise.resolve(body) };
  }

  it("user role POST → key gets userId attached", async () => {
    mockSession = { role: "user", userId: "user-A", email: "a@example.com" };

    const { POST } = await import("@/app/api/keys/route.js");
    const res = await POST(makeRequest({ name: "my-key", description: "My desc" }));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.userId).toBe("user-A");
    expect(data.description).toBe("My desc");
  });

  it("admin role POST → key has userId=null", async () => {
    mockSession = { role: "admin" };

    const { POST } = await import("@/app/api/keys/route.js");
    const res = await POST(makeRequest({ name: "admin-key" }));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.userId).toBeNull();
  });

  it("user POST 11th key → 400 limit error", async () => {
    mockSession = { role: "user", userId: "user-limit", email: "l@example.com" };

    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    for (let i = 0; i < 10; i++) {
      await createApiKey(`k${i}`, "test-machine-id", "user-limit");
    }

    const { POST } = await import("@/app/api/keys/route.js");
    const res = await POST(makeRequest({ name: "one-too-many" }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("10 keys");
  });

  it("POST missing name → 400", async () => {
    mockSession = { role: "admin" };

    const { POST } = await import("@/app/api/keys/route.js");
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
  });
});

describe("PUT /api/keys/[id]", () => {
  function makeRequest(body) {
    return { json: () => Promise.resolve(body) };
  }
  function makeParams(id) {
    return { params: Promise.resolve({ id }) };
  }

  it("user can update own key description", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("my-key", "test-machine-id", "user-A");

    mockSession = { role: "user", userId: "user-A" };

    const { PUT } = await import("@/app/api/keys/[id]/route.js");
    const res = await PUT(makeRequest({ description: "Updated desc" }), makeParams(key.id));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.key.description).toBe("Updated desc");
  });

  it("user PUT on other user's key → 403", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("other-key", "test-machine-id", "user-B");

    mockSession = { role: "user", userId: "user-A" };

    const { PUT } = await import("@/app/api/keys/[id]/route.js");
    const res = await PUT(makeRequest({ isActive: false }), makeParams(key.id));

    expect(res.status).toBe(403);
  });

  it("admin can update any key", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("user-key", "test-machine-id", "user-B");

    mockSession = { role: "admin" };

    const { PUT } = await import("@/app/api/keys/[id]/route.js");
    const res = await PUT(makeRequest({ description: "Admin updated" }), makeParams(key.id));

    expect(res.status).toBe(200);
  });

  it("PUT non-existent key → 404", async () => {
    mockSession = { role: "admin" };

    const { PUT } = await import("@/app/api/keys/[id]/route.js");
    const res = await PUT(makeRequest({ isActive: false }), makeParams("no-such-id"));

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/keys/[id]", () => {
  function makeParams(id) {
    return { params: Promise.resolve({ id }) };
  }

  it("user can delete own key", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("del-key", "test-machine-id", "user-A");

    mockSession = { role: "user", userId: "user-A" };

    const { DELETE } = await import("@/app/api/keys/[id]/route.js");
    const res = await DELETE({}, makeParams(key.id));

    expect(res.status).toBe(200);
  });

  it("user DELETE other user's key → 403", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("other-del", "test-machine-id", "user-B");

    mockSession = { role: "user", userId: "user-A" };

    const { DELETE } = await import("@/app/api/keys/[id]/route.js");
    const res = await DELETE({}, makeParams(key.id));

    expect(res.status).toBe(403);
  });

  it("admin can delete any key", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("any-key", "test-machine-id", "user-C");

    mockSession = { role: "admin" };

    const { DELETE } = await import("@/app/api/keys/[id]/route.js");
    const res = await DELETE({}, makeParams(key.id));

    expect(res.status).toBe(200);
  });

  it("DELETE non-existent key → 404", async () => {
    mockSession = { role: "admin" };

    const { DELETE } = await import("@/app/api/keys/[id]/route.js");
    const res = await DELETE({}, makeParams("no-such-id"));

    expect(res.status).toBe(404);
  });
});

// Story 2.23 — per-key creditLimit validation (AC6)
describe("POST /api/keys — creditLimit validation", () => {
  it("rejects negative creditLimit with 400", async () => {
    mockSession = { role: "user", userId: "user-A", email: "a@example.com" };
    const { POST } = await import("@/app/api/keys/route.js");
    const req = { json: async () => ({ name: "k", creditLimit: -5 }) };
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/creditLimit/i);
  });

  it("rejects non-numeric creditLimit with 400", async () => {
    mockSession = { role: "user", userId: "user-A", email: "a@example.com" };
    const { POST } = await import("@/app/api/keys/route.js");
    const req = { json: async () => ({ name: "k", creditLimit: "abc" }) };
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("whitespace-only creditLimit → treated as unlimited (null), not 0", async () => {
    mockSession = { role: "user", userId: "user-A", email: "a@example.com" };
    const { POST } = await import("@/app/api/keys/route.js");
    const req = { json: async () => ({ name: "k", creditLimit: "   " }) };
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.creditLimit ?? null).toBeNull();
  });

  it("valid creditLimit → 201 with creditLimit set", async () => {
    mockSession = { role: "user", userId: "user-A", email: "a@example.com" };
    const { POST } = await import("@/app/api/keys/route.js");
    const req = { json: async () => ({ name: "k", creditLimit: 5 }) };
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.creditLimit).toBe(5);
  });
});

describe("PUT /api/keys/[id] — creditLimit validation", () => {
  function makeParams(id) { return { params: Promise.resolve({ id }) }; }

  it("rejects negative creditLimit with 400", async () => {
    mockSession = { role: "user", userId: "user-A", email: "a@example.com" };
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("k", "test-machine-id", "user-A");
    const { PUT } = await import("@/app/api/keys/[id]/route.js");
    const req = { json: async () => ({ creditLimit: -1 }) };
    const res = await PUT(req, makeParams(key.id));
    expect(res.status).toBe(400);
  });
});
