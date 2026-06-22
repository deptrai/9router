// Story 2.3 Task 1: apiKeysRepo ownership tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-apiKeysOwnership-"));
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

describe("apiKeysRepo ownership", () => {
  it("createApiKey with userId: 10th key OK, 11th throws KEY_LIMIT", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");

    // Create 10 keys for user
    for (let i = 0; i < 10; i++) {
      await createApiKey(`key-${i}`, "machine-1", "user-123", `desc ${i}`);
    }

    // 11th should throw
    await expect(
      createApiKey("key-11", "machine-1", "user-123", "too many")
    ).rejects.toThrow("Key limit reached: max 10 keys per user");

    // Verify error has code
    await expect(
      createApiKey("key-11b", "machine-1", "user-123")
    ).rejects.toMatchObject({ code: "KEY_LIMIT" });
  });

  it("createApiKey without userId (legacy/admin): no limit", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");

    // Create 15 keys without userId — should all succeed
    for (let i = 0; i < 15; i++) {
      const key = await createApiKey(`admin-${i}`, "machine-1");
      expect(key.id).toBeTruthy();
    }
  });

  it("10-key limit counts only active keys", async () => {
    const { createApiKey, updateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");

    // Create 10 keys
    const keys = [];
    for (let i = 0; i < 10; i++) {
      keys.push(await createApiKey(`key-${i}`, "machine-1", "user-456"));
    }

    // Deactivate one
    await updateApiKey(keys[0].id, { isActive: false });

    // Now user has 9 active → can create 1 more
    const newKey = await createApiKey("key-new", "machine-1", "user-456");
    expect(newKey.id).toBeTruthy();

    // But not another (10 active again)
    await expect(
      createApiKey("key-overflow", "machine-1", "user-456")
    ).rejects.toThrow("Key limit reached");
  });

  it("getApiKeysByUser returns only keys for that user", async () => {
    const { createApiKey, getApiKeysByUser } = await import("@/lib/db/repos/apiKeysRepo.js");

    await createApiKey("u1-key", "machine-1", "user-A", "A's key");
    await createApiKey("u2-key", "machine-1", "user-B", "B's key");
    await createApiKey("admin-key", "machine-1"); // no userId

    const userAKeys = await getApiKeysByUser("user-A");
    expect(userAKeys.length).toBe(1);
    expect(userAKeys[0].name).toBe("u1-key");
    expect(userAKeys[0].userId).toBe("user-A");

    const userBKeys = await getApiKeysByUser("user-B");
    expect(userBKeys.length).toBe(1);
    expect(userBKeys[0].name).toBe("u2-key");
  });

  it("getApiKeysByUser returns empty for non-existent user", async () => {
    const { getApiKeysByUser } = await import("@/lib/db/repos/apiKeysRepo.js");
    const keys = await getApiKeysByUser("ghost-user");
    expect(keys).toEqual([]);
  });

  it("updateLastUsed updates the lastUsedAt field", async () => {
    const { createApiKey, getApiKeyByKey, updateLastUsed } = await import("@/lib/db/repos/apiKeysRepo.js");

    const key = await createApiKey("last-used-test", "machine-1", "user-X");
    expect(key.lastUsedAt).toBeNull();

    await updateLastUsed(key.key);

    const updated = await getApiKeyByKey(key.key);
    expect(updated.lastUsedAt).not.toBeNull();
    expect(new Date(updated.lastUsedAt).getTime()).toBeGreaterThan(0);
  });

  it("updateLastUsed on non-existent key does not throw", async () => {
    const { updateLastUsed } = await import("@/lib/db/repos/apiKeysRepo.js");
    // Should not throw
    await expect(updateLastUsed("non-existent-key")).resolves.toBeUndefined();
  });

  it("exports are available from barrel (src/lib/db/index.js)", async () => {
    const db = await import("@/lib/db/index.js");
    expect(typeof db.getApiKeysByUser).toBe("function");
    expect(typeof db.updateLastUsed).toBe("function");
  });
});
