// Story 2.1: Verify users table + apiKeys new columns + export/import
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-saas-schema-"));
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

describe("Story 2.1 — SaaS Schema", () => {
  it("AC1: fresh DB creates users table with all columns", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toContain("users");

    const cols = db.all(`PRAGMA table_info(users)`).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      "id", "email", "passwordHash", "displayName", "isActive",
      "isEmailVerified", "creditsBalance", "createdAt", "updatedAt",
    ]));
  });

  it("AC1: idx_users_email index exists", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const indexes = db.all(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users'`).map(i => i.name);
    expect(indexes).toContain("idx_users_email");
  });

  it("AC2: apiKeys has userId, description, lastUsedAt columns", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const cols = db.all(`PRAGMA table_info(apiKeys)`).map(c => c.name);
    expect(cols).toContain("userId");
    expect(cols).toContain("description");
    expect(cols).toContain("lastUsedAt");
  });

  it("AC2: idx_ak_user index exists", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const indexes = db.all(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='apiKeys'`).map(i => i.name);
    expect(indexes).toContain("idx_ak_user");
  });

  it("AC3: rowToKey returns userId, description, lastUsedAt", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    // Insert a key manually with new columns
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, userId, description, lastUsedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["test-id", "sk-test-key", "Test Key", "machine1", 1, new Date().toISOString(), "user-123", "My desc", "2026-06-06T00:00:00Z"]
    );

    const { getApiKeyById } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await getApiKeyById("test-id");

    expect(key).not.toBeNull();
    expect(key.userId).toBe("user-123");
    expect(key.description).toBe("My desc");
    expect(key.lastUsedAt).toBe("2026-06-06T00:00:00Z");
    expect(key.id).toBe("test-id");
    expect(key.name).toBe("Test Key");
    expect(key.isActive).toBe(true);
  });

  it("AC3: rowToKey returns null for new fields when not set", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    // Insert a legacy-style key (no new columns)
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
      ["legacy-id", "sk-legacy", "Legacy", "machine2", 1, new Date().toISOString()]
    );

    const { getApiKeyById } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await getApiKeyById("legacy-id");

    expect(key.userId).toBeNull();
    expect(key.description).toBeNull();
    expect(key.lastUsedAt).toBeNull();
  });

  it("AC4: createApiKey backward-compat (no userId/description)", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test", "machine-abc");

    expect(key.userId).toBeNull();
    expect(key.description).toBeNull();
    expect(key.lastUsedAt).toBeNull();
    expect(key.name).toBe("test");
    expect(key.key).toBeTruthy();
  });

  it("AC4: createApiKey with userId and description", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("user-key", "machine-abc", "user-456", "For CI/CD");

    expect(key.userId).toBe("user-456");
    expect(key.description).toBe("For CI/CD");
  });

  it("AC5: updateApiKey writes new columns", async () => {
    const { createApiKey, updateApiKey, getApiKeyById } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("upd-test", "machine-abc");

    const updated = await updateApiKey(key.id, {
      userId: "user-789",
      description: "Updated desc",
      lastUsedAt: "2026-06-06T12:00:00Z",
    });

    expect(updated.userId).toBe("user-789");
    expect(updated.description).toBe("Updated desc");
    expect(updated.lastUsedAt).toBe("2026-06-06T12:00:00Z");

    // Verify via re-read
    const reread = await getApiKeyById(key.id);
    expect(reread.userId).toBe("user-789");
    expect(reread.description).toBe("Updated desc");
    expect(reread.lastUsedAt).toBe("2026-06-06T12:00:00Z");
    // Old fields preserved
    expect(reread.name).toBe("upd-test");
    expect(reread.isActive).toBe(true);
  });

  it("AC5: updateApiKey partial update preserves existing values", async () => {
    const { createApiKey, updateApiKey, getApiKeyById } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("partial-test", "machine-abc", "user-111", "Original desc");

    // Only update lastUsedAt
    await updateApiKey(key.id, { lastUsedAt: "2026-06-06T15:00:00Z" });
    const reread = await getApiKeyById(key.id);
    expect(reread.userId).toBe("user-111");
    expect(reread.description).toBe("Original desc");
    expect(reread.lastUsedAt).toBe("2026-06-06T15:00:00Z");
  });

  it("AC6: exportDb includes new apiKeys fields", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    await createApiKey("export-test", "machine-abc", "user-exp", "Export desc");

    const { exportDb } = await import("@/lib/db/index.js");
    const exported = await exportDb();

    const expKey = exported.apiKeys.find(k => k.name === "export-test");
    expect(expKey).toBeDefined();
    expect(expKey.userId).toBe("user-exp");
    expect(expKey.description).toBe("Export desc");
    expect(expKey.lastUsedAt).toBeNull();
  });

  it("AC6: importDb with new fields preserves them", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter(); // init DB

    const { importDb } = await import("@/lib/db/index.js");
    const payload = {
      settings: { foo: "bar" },
      apiKeys: [{
        id: "imp-1", key: "sk-import-test", name: "Imported",
        machineId: "m1", isActive: true, createdAt: "2026-01-01T00:00:00Z",
        userId: "user-imp", description: "Imported desc", lastUsedAt: "2026-06-01T00:00:00Z",
      }],
    };
    await importDb(payload);

    const { getApiKeyById } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await getApiKeyById("imp-1");
    expect(key.userId).toBe("user-imp");
    expect(key.description).toBe("Imported desc");
    expect(key.lastUsedAt).toBe("2026-06-01T00:00:00Z");
  });

  it("AC6: importDb with legacy payload (no new fields) defaults to null", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();

    const { importDb } = await import("@/lib/db/index.js");
    const legacyPayload = {
      settings: { legacy: true },
      apiKeys: [{
        id: "leg-1", key: "sk-legacy-imp", name: "Legacy Import",
        machineId: "m2", isActive: true, createdAt: "2025-01-01T00:00:00Z",
        // NO userId, description, lastUsedAt
      }],
    };
    await importDb(legacyPayload);

    const { getApiKeyById } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await getApiKeyById("leg-1");
    expect(key.userId).toBeNull();
    expect(key.description).toBeNull();
    expect(key.lastUsedAt).toBeNull();
  });
});
