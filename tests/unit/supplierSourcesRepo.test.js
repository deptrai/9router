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

// telegram_bot_scraper validate() is fail-closed on the relay endpoint + token as well as
// the exchange rate (code review 2026-07-28), so a valid scraper config needs all four.
const SCRAPER_AUTH = Object.freeze({
  botUsername: "tainguyenvibebot",
  command: "/products",
  vndPerCredit: 1000,
  relayUrl: "http://127.0.0.1:3800/relay",
  relayToken: "test-relay-token",
});

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

describe("supplierSourcesRepo — telegram_bot_scraper interval guard (AC7, course correction)", () => {
  it("create rejects syncIntervalSec < 3600 instead of clamping to the generic 60s minimum", async () => {
    await expect(repo.createSupplierSource({
      name: "Tài Nguyên Vibe",
      adapterType: "telegram_bot_scraper",
      syncIntervalSec: 300,
      auth: { ...SCRAPER_AUTH },
    })).rejects.toThrow(/syncIntervalSec must be >= 3600 for telegram_bot_scraper/);
    // Must not write a row on rejection.
    expect(await repo.listSupplierSources()).toHaveLength(0);
  });

  it("create accepts syncIntervalSec >= 3600 for telegram_bot_scraper", async () => {
    const src = await repo.createSupplierSource({
      name: "Tài Nguyên Vibe",
      adapterType: "telegram_bot_scraper",
      syncIntervalSec: 3600,
      auth: { ...SCRAPER_AUTH },
    });
    expect(src.status).toBe("active");
    expect(src.syncIntervalSec).toBe(3600);
  });

  it("other adapter types keep the generic 60s minimum on create (no regression)", async () => {
    const src = await repo.createSupplierSource({
      name: "Acme", adapterType: "supplier_api", syncIntervalSec: 10,
      auth: { apiUrl: "https://acme/api", apiKey: "k" },
    });
    expect(src.syncIntervalSec).toBe(60);
  });

  it("update rejects syncIntervalSec < 3600 for telegram_bot_scraper even without an auth patch", async () => {
    const src = await repo.createSupplierSource({
      name: "Tài Nguyên Vibe",
      adapterType: "telegram_bot_scraper",
      syncIntervalSec: 3600,
      auth: { ...SCRAPER_AUTH },
    });

    await expect(repo.updateSupplierSource(src.id, { syncIntervalSec: 120 }))
      .rejects.toThrow(/syncIntervalSec must be >= 3600 for telegram_bot_scraper/);

    // Row must remain unchanged after the rejected update.
    const unchanged = await repo.getSupplierSourceById(src.id);
    expect(unchanged.syncIntervalSec).toBe(3600);
  });

  it("update accepts syncIntervalSec >= 3600 for telegram_bot_scraper", async () => {
    const src = await repo.createSupplierSource({
      name: "Tài Nguyên Vibe",
      adapterType: "telegram_bot_scraper",
      syncIntervalSec: 3600,
      auth: { ...SCRAPER_AUTH },
    });
    const updated = await repo.updateSupplierSource(src.id, { syncIntervalSec: 7200 });
    expect(updated.syncIntervalSec).toBe(7200);
  });

  it("update still applies the generic 60s minimum for non-scraper adapters (no regression)", async () => {
    const src = await repo.createSupplierSource({
      name: "Acme", adapterType: "supplier_api",
      auth: { apiUrl: "https://acme/api", apiKey: "k" },
    });
    const updated = await repo.updateSupplierSource(src.id, { syncIntervalSec: 10 });
    expect(updated.syncIntervalSec).toBe(60);
  });

  it.each([Infinity, -Infinity, NaN, "abc"])(
    "rejects a non-finite syncIntervalSec (%s) instead of creating a source that never polls",
    async (syncIntervalSec) => {
      // Math.max(60, Infinity) used to survive and produce a source whose next poll is
      // never due — a silently dead source.
      const promise = repo.createSupplierSource({
        name: "Acme", adapterType: "supplier_api", syncIntervalSec,
        auth: { apiUrl: "https://acme/api", apiKey: "k" },
      });
      if (Number.isFinite(Number(syncIntervalSec))) {
        await expect(promise).resolves.toBeTruthy();
      } else {
        await expect(promise).rejects.toThrow(/syncIntervalSec must be a finite number/);
      }
    },
  );
});

describe("supplierSourcesRepo — update auth merge semantics (code review 2026-07-28, D4)", () => {
  it("merges a partial auth patch instead of replacing the whole blob", async () => {
    // maskSource never returns auth, so a client cannot read relayUrl/interactionSteps back
    // in order to re-send them. Replace semantics silently dropped everything omitted.
    const src = await repo.createSupplierSource({
      name: "Tài Nguyên Vibe",
      adapterType: "telegram_bot_scraper",
      syncIntervalSec: 3600,
      auth: { ...SCRAPER_AUTH },
    });

    await repo.updateSupplierSource(src.id, { auth: { vndPerCredit: 2000 } });

    const withAuth = await repo.getSupplierSourceWithAuth(src.id);
    expect(withAuth.auth.vndPerCredit).toBe(2000);
    expect(withAuth.auth.relayUrl).toBe(SCRAPER_AUTH.relayUrl);
    expect(withAuth.auth.relayToken).toBe(SCRAPER_AUTH.relayToken);
    expect(withAuth.auth.botUsername).toBe(SCRAPER_AUTH.botUsername);
  });

  it("a partial patch that would break the merged config is rejected", async () => {
    const src = await repo.createSupplierSource({
      name: "Tài Nguyên Vibe", adapterType: "telegram_bot_scraper",
      syncIntervalSec: 3600, auth: { ...SCRAPER_AUTH },
    });

    await expect(repo.updateSupplierSource(src.id, { auth: { vndPerCredit: 0 } }))
      .rejects.toThrow(/invalid config.*vndPerCredit/i);
  });

  it("auth: null clears the stored credentials", async () => {
    const src = await repo.createSupplierSource({
      name: "Acme", adapterType: "supplier_api",
      auth: { apiUrl: "https://acme/api", apiKey: "k" },
    });

    const updated = await repo.updateSupplierSource(src.id, { auth: null });

    expect(updated.hasAuth).toBe(false);
  });

  it("heals unsupported → active only on a real config change, not on a name patch", async () => {
    const src = await repo.createSupplierSource({
      name: "Private Bot", adapterType: "supplier_api",
      auth: { apiUrl: "https://x", apiKey: "k", scrape: true },
    });
    expect(src.status).toBe("unsupported");

    // A rename is not a config change — `unsupported` must stay sticky, as it does for
    // recordSyncSuccess / recordSyncFailure / enableSupplierSource.
    const renamed = await repo.updateSupplierSource(src.id, { name: "Private Bot v2" });
    expect(renamed.status).toBe("unsupported");

    // Supplying a valid config is the one event that legitimately clears it.
    const fixed = await repo.updateSupplierSource(src.id, {
      auth: { apiUrl: "https://x", apiKey: "k", scrape: false },
    });
    expect(fixed.status).toBe("active");
  });
});

describe("supplierSourcesRepo — undecryptable auth stays operable (code review 2026-07-28)", () => {
  async function corruptAuth(id) {
    const db = await getAdapter();
    db.run(`UPDATE supplierSources SET authEnc = ? WHERE id = ?`, ["not-a-valid-ciphertext", id]);
  }

  it("allows rename and disable, and reports a decryption error rather than 'invalid config'", async () => {
    // validate() now runs on EVERY update, so falling back to {} on a decrypt failure made
    // the row impossible to rename OR switch off — removing the operator's only way to stop
    // the bleeding — and blamed "invalid config" for a key/ciphertext problem.
    const src = await repo.createSupplierSource({
      name: "Acme", adapterType: "supplier_api",
      auth: { apiUrl: "https://acme/api", apiKey: "k" },
    });
    await corruptAuth(src.id);

    const disabled = await repo.updateSupplierSource(src.id, { name: "Acme (broken)", isActive: false });

    expect(disabled.name).toBe("Acme (broken)");
    expect(disabled.isActive).toBe(false);
    expect(disabled.lastSyncError).toMatch(/could not be decrypted/i);
  });

  it("re-entering full credentials recovers the source", async () => {
    const src = await repo.createSupplierSource({
      name: "Acme", adapterType: "supplier_api",
      auth: { apiUrl: "https://acme/api", apiKey: "k" },
    });
    await corruptAuth(src.id);

    await repo.updateSupplierSource(src.id, { auth: { apiUrl: "https://acme/api", apiKey: "fresh" } });

    const withAuth = await repo.getSupplierSourceWithAuth(src.id);
    expect(withAuth.authError).toBeNull();
    expect(withAuth.auth.apiKey).toBe("fresh");
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
