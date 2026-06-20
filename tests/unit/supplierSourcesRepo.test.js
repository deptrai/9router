/**
 * Story 2.30 — supplierSourcesRepo: CRUD + validate + auth encrypt/mask + health lifecycle.
 * AC1 (create/encrypt/mask), AC2 (markUnsupported), AC5 (degraded/unhealthy).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalEncKey = process.env.STORE_ENC_KEY;
const TEST_ENC_KEY = "0".repeat(64);

let repo, getAdapter;

async function loadModules() {
  repo = await import("@/lib/db/repos/supplierSourcesRepo.js");
  ({ getAdapter } = await import("@/lib/db/driver.js"));
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-suppliers-"));
  process.env.DATA_DIR = tempDir;
  process.env.STORE_ENC_KEY = TEST_ENC_KEY;
  delete global._dbAdapter;
  vi.resetModules();
  await loadModules();
  await getAdapter();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalEncKey === undefined) delete process.env.STORE_ENC_KEY;
  else process.env.STORE_ENC_KEY = originalEncKey;
});

describe("supplierSourcesRepo — enums + create/validate (AC1)", () => {
  it("exports canonical enums", () => {
    expect(repo.ADAPTER_TYPES).toEqual(["supplier_api", "channel_feed", "polling_feed", "webhook", "telegram_bot_scraper"]);
    expect(repo.SYNC_MODES).toEqual(["webhook", "polling"]);
    expect(repo.SOURCE_STATUSES).toEqual(["active", "degraded", "unhealthy", "unsupported"]);
  });

  it("creates a valid supplier_api source, status=active, auth masked", async () => {
    const src = await repo.createSupplierSource({
      name: "Acme API",
      adapterType: "supplier_api",
      syncMode: "polling",
      auth: { apiUrl: "https://acme.example/api", apiKey: "secret-123" },
    });
    expect(src.status).toBe("active");
    expect(src.hasAuth).toBe(true);
    // CRITICAL: never expose authEnc/plaintext
    expect(src.authEnc).toBeUndefined();
    expect(JSON.stringify(src)).not.toContain("secret-123");
  });

  it("rejects invalid adapterType", async () => {
    await expect(repo.createSupplierSource({
      name: "x", adapterType: "scrape_bot", auth: {},
    })).rejects.toThrow(/adapterType must be one of/);
  });

  it("rejects invalid syncMode", async () => {
    await expect(repo.createSupplierSource({
      name: "x", adapterType: "supplier_api", syncMode: "telepathy",
      auth: { apiUrl: "https://x", apiKey: "k" },
    })).rejects.toThrow(/syncMode must be one of/);
  });

  it("hard-rejects supplier_api missing required config", async () => {
    await expect(repo.createSupplierSource({
      name: "x", adapterType: "supplier_api", auth: {},
    })).rejects.toThrow(/invalid config/);
  });
});

describe("supplierSourcesRepo — unsupported integration (AC2)", () => {
  it("scrape config → status=unsupported (created, not thrown)", async () => {
    const src = await repo.createSupplierSource({
      name: "Private Bot",
      adapterType: "supplier_api",
      auth: { apiUrl: "https://x", apiKey: "k", scrape: true },
    });
    expect(src.status).toBe("unsupported");
    expect(src.lastSyncError).toMatch(/out-of-scope|MVP/i);
  });

  it("markSourceUnsupported flips status + reason", async () => {
    const src = await repo.createSupplierSource({
      name: "Acme", adapterType: "polling_feed", auth: { feedUrl: "https://acme/feed" },
    });
    const updated = await repo.markSourceUnsupported(src.id, "No public feed available");
    expect(updated.status).toBe("unsupported");
    expect(updated.lastSyncError).toMatch(/No public feed/);
  });
});

describe("supplierSourcesRepo — mask on list/get (AC1/QĐ8)", () => {
  it("listSupplierSources + getById never leak authEnc", async () => {
    await repo.createSupplierSource({
      name: "Acme", adapterType: "supplier_api",
      auth: { apiUrl: "https://acme/api", apiKey: "top-secret-key" },
    });
    const list = await repo.listSupplierSources();
    expect(list).toHaveLength(1);
    expect(list[0].hasAuth).toBe(true);
    expect(list[0].authEnc).toBeUndefined();
    const got = await repo.getSupplierSourceById(list[0].id);
    expect(JSON.stringify(got)).not.toContain("top-secret-key");
  });

  it("getSupplierSourceWithAuth (internal) returns decrypted auth", async () => {
    const src = await repo.createSupplierSource({
      name: "Acme", adapterType: "supplier_api",
      auth: { apiUrl: "https://acme/api", apiKey: "top-secret-key" },
    });
    const withAuth = await repo.getSupplierSourceWithAuth(src.id);
    expect(withAuth.auth.apiKey).toBe("top-secret-key");
    expect(withAuth.auth.apiUrl).toBe("https://acme/api");
  });
});

describe("supplierSourcesRepo — health lifecycle (AC5/QĐ6)", () => {
  async function seed() {
    return repo.createSupplierSource({
      name: "Acme", adapterType: "supplier_api",
      auth: { apiUrl: "https://acme/api", apiKey: "k" },
    });
  }

  it("active → degraded → unhealthy on consecutive failures", async () => {
    const src = await seed();
    let s = await repo.recordSyncFailure(src.id, "HTTP 500");
    expect(s.status).toBe("degraded");
    expect(s.lastSyncError).toBe("HTTP 500");
    s = await repo.recordSyncFailure(src.id, "HTTP 503");
    expect(s.status).toBe("unhealthy");
    expect(s.lastSyncError).toBe("HTTP 503");
  });

  it("recordSyncSuccess resets to active + clears error + bumps version", async () => {
    const src = await seed();
    await repo.recordSyncFailure(src.id, "HTTP 500");
    const s = await repo.recordSyncSuccess(src.id, { syncVersion: 5 });
    expect(s.status).toBe("active");
    expect(s.lastSyncError).toBeNull();
    expect(s.syncVersion).toBe(5);
    expect(s.lastSyncedAt).toBeTruthy();
  });

  it("unsupported source stays unsupported through sync success/failure", async () => {
    const src = await repo.createSupplierSource({
      name: "x", adapterType: "supplier_api",
      auth: { apiUrl: "https://x", apiKey: "k", scrape: true },
    });
    expect(src.status).toBe("unsupported");
    const afterFail = await repo.recordSyncFailure(src.id, "err");
    expect(afterFail.status).toBe("unsupported");
    const afterOk = await repo.recordSyncSuccess(src.id, { syncVersion: 1 });
    expect(afterOk.status).toBe("unsupported");
  });
});

describe("supplierSourcesRepo — update/delete/pollable", () => {
  it("listPollableSources returns never-synced polling sources", async () => {
    await repo.createSupplierSource({
      name: "Acme", adapterType: "polling_feed", syncMode: "polling",
      auth: { feedUrl: "https://acme/feed" },
    });
    const due = await repo.listPollableSources();
    expect(due).toHaveLength(1);
  });

  it("deleteSupplierSource removes the row", async () => {
    const src = await repo.createSupplierSource({
      name: "x", adapterType: "polling_feed", auth: { feedUrl: "https://x/feed" },
    });
    expect(await repo.deleteSupplierSource(src.id)).toBe(true);
    expect(await repo.getSupplierSourceById(src.id)).toBeNull();
  });
});
