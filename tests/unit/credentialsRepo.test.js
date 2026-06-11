// Story 2.27 — credentialsRepo unit tests
// Verifies: addCredential (encrypted), listCredentials, countAvailableCredentials,
// getAvailableCredentialSync (FIFO), deliverCredentialSync, revokeCredential,
// getDecryptedPayload, AC5 (no plaintext in mapper)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalEncKey = process.env.STORE_ENC_KEY;
// Fixed 32-byte test key (hex 64 chars) — never used in production
const TEST_ENC_KEY = "0".repeat(64);

let addCredential, listCredentials, getCredentialById, countAvailableCredentials,
    getAvailableCredentialSync, deliverCredentialSync, revokeCredential, getDecryptedPayload,
    reserveCredentialByIdSync, releaseReservationSync,
    createProduct, getAdapter;

async function loadModules() {
  ({ addCredential, listCredentials, getCredentialById, countAvailableCredentials,
     getAvailableCredentialSync, deliverCredentialSync, revokeCredential, getDecryptedPayload,
     reserveCredentialByIdSync, releaseReservationSync } =
    await import("@/lib/db/repos/credentialsRepo.js"));
  ({ createProduct } = await import("@/lib/db/repos/productsRepo.js"));
  ({ getAdapter } = await import("@/lib/db/driver.js"));
}

async function seedProduct(overrides = {}) {
  return createProduct({
    kind: "credential", name: "Test Credential", priceCredits: 100,
    deliveryMode: "instant", ...overrides,
  });
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-creds-"));
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

describe("addCredential", () => {
  it("stores a credential and returns it without exposing payload (AC5)", async () => {
    const product = await seedProduct();
    const cred = await addCredential(product.id, { username: "alice", password: "s3cr3t" });
    expect(cred.productId).toBe(product.id);
    expect(cred.status).toBe("available");
    expect(cred.hasPayload).toBe(true);
    // Mapper must NOT expose plaintext or ciphertext
    expect(cred.payload).toBeUndefined();
    expect(cred.payloadEnc).toBeUndefined();
    expect(cred.orderId).toBeNull();
  });

  it("accepts a string payload and round-trips via getDecryptedPayload", async () => {
    const product = await seedProduct();
    const cred = await addCredential(product.id, "raw-api-key-abc123");
    expect(cred.hasPayload).toBe(true);
    const plain = await getDecryptedPayload(cred.id);
    expect(plain).toBe("raw-api-key-abc123");
  });

  it("round-trips object payload via getDecryptedPayload", async () => {
    const product = await seedProduct();
    const cred = await addCredential(product.id, { username: "bob", password: "hunter2" });
    const plain = await getDecryptedPayload(cred.id);
    expect(JSON.parse(plain)).toEqual({ username: "bob", password: "hunter2" });
  });

  it("throws on missing productId", async () => {
    await expect(addCredential(null, { username: "x" })).rejects.toThrow("productId");
  });

  it("throws on missing payload", async () => {
    const product = await seedProduct();
    await expect(addCredential(product.id, null)).rejects.toThrow("payload");
  });

  it("throws when STORE_ENC_KEY is missing", async () => {
    delete process.env.STORE_ENC_KEY;
    vi.resetModules();
    await loadModules();
    const product = await seedProduct();
    await expect(addCredential(product.id, "secret")).rejects.toThrow("STORE_ENC_KEY");
  });
});

describe("listCredentials / countAvailableCredentials", () => {
  it("lists all credentials for a product", async () => {
    const product = await seedProduct();
    await addCredential(product.id, { k: 1 });
    await addCredential(product.id, { k: 2 });
    const all = await listCredentials(product.id);
    expect(all).toHaveLength(2);
    // AC5: no payload exposed in list
    expect(all[0].payload).toBeUndefined();
    expect(all[0].hasPayload).toBe(true);
  });

  it("filters by status", async () => {
    const product = await seedProduct();
    await addCredential(product.id, { k: 1 });
    await addCredential(product.id, { k: 2 });
    const available = await listCredentials(product.id, { status: "available" });
    expect(available).toHaveLength(2);
    const delivered = await listCredentials(product.id, { status: "delivered" });
    expect(delivered).toHaveLength(0);
  });

  it("countAvailableCredentials returns correct count", async () => {
    const product = await seedProduct();
    expect(await countAvailableCredentials(product.id)).toBe(0);
    await addCredential(product.id, { k: 1 });
    await addCredential(product.id, { k: 2 });
    expect(await countAvailableCredentials(product.id)).toBe(2);
  });
});

describe("getAvailableCredentialSync / deliverCredentialSync", () => {
  it("picks FIFO and marks delivered", async () => {
    const product = await seedProduct();
    const c1 = await addCredential(product.id, { seq: 1 });
    await addCredential(product.id, { seq: 2 });
    const adapter = await getAdapter();
    let picked;
    adapter.transaction(() => {
      picked = getAvailableCredentialSync(adapter, product.id);
      deliverCredentialSync(adapter, picked.id, "order-1", "item-1");
    });
    expect(picked.id).toBe(c1.id);
    const updated = await getCredentialById(picked.id);
    expect(updated.status).toBe("delivered");
    expect(updated.orderId).toBe("order-1");
    expect(updated.orderItemId).toBe("item-1");
    expect(updated.deliveredAt).toBeTruthy();
    expect(await countAvailableCredentials(product.id)).toBe(1);
  });

  it("returns null when inventory is empty", async () => {
    const product = await seedProduct();
    const adapter = await getAdapter();
    let picked;
    adapter.transaction(() => { picked = getAvailableCredentialSync(adapter, product.id); });
    expect(picked).toBeNull();
  });

  it("throws when credential already delivered", async () => {
    const product = await seedProduct();
    const c = await addCredential(product.id, { k: 1 });
    const adapter = await getAdapter();
    adapter.transaction(() => {
      deliverCredentialSync(adapter, c.id, "o1", "i1");
    });
    expect(() => {
      adapter.transaction(() => {
        deliverCredentialSync(adapter, c.id, "o2", "i2");
      });
    }).toThrow("no longer available");
  });
});

describe("revokeCredential", () => {
  it("marks credential as revoked", async () => {
    const product = await seedProduct();
    const c = await addCredential(product.id, { k: 1 });
    await revokeCredential(c.id, { note: "compromised" });
    const updated = await getCredentialById(c.id);
    expect(updated.status).toBe("revoked");
    expect(updated.note).toBe("compromised");
  });
});

describe("getDecryptedPayload", () => {
  it("throws on unknown credential id", async () => {
    await expect(getDecryptedPayload("nonexistent-id")).rejects.toThrow("not found");
  });

  it("tampered ciphertext throws on decrypt", async () => {
    const product = await seedProduct();
    const cred = await addCredential(product.id, "sensitive-data");
    // Corrupt stored ciphertext directly
    const adapter = await getAdapter();
    adapter.run(`UPDATE productCredentials SET payload = 'corrupted.blob.here' WHERE id = ?`, [cred.id]);
    await expect(getDecryptedPayload(cred.id)).rejects.toThrow();
  });
});

// Story 2.28 — admin fulfillment helpers
describe("reserveCredentialByIdSync (Story 2.28)", () => {
  it("reserves a specific available credential by id", async () => {
    const product = await seedProduct();
    const cred = await addCredential(product.id, { k: "v" });
    const adapter = await getAdapter();
    let reserved;
    adapter.transaction(() => {
      reserved = reserveCredentialByIdSync(adapter, cred.id, "o1", "i1", new Date().toISOString());
    });
    expect(reserved.status).toBe("reserved");
    expect(reserved.orderId).toBe("o1");
    expect(reserved.reservedAt).toBeTruthy();
  });

  it("throws if the credential is not available (already reserved/taken)", async () => {
    const product = await seedProduct();
    const cred = await addCredential(product.id, { k: "v" });
    const adapter = await getAdapter();
    adapter.transaction(() => {
      reserveCredentialByIdSync(adapter, cred.id, "o1", "i1", new Date().toISOString());
    });
    // Second reservation of the same row must fail.
    expect(() =>
      adapter.transaction(() => {
        reserveCredentialByIdSync(adapter, cred.id, "o2", "i2", new Date().toISOString());
      })
    ).toThrow("not available");
  });

  it("throws for an unknown credential id", async () => {
    const adapter = await getAdapter();
    expect(() =>
      adapter.transaction(() => {
        reserveCredentialByIdSync(adapter, "ghost", "o1", "i1", new Date().toISOString());
      })
    ).toThrow("not available");
  });
});

describe("releaseReservationSync (Story 2.28)", () => {
  it("releases reserved credentials for an order back to available", async () => {
    const product = await seedProduct();
    const a = await addCredential(product.id, { k: "a" });
    const b = await addCredential(product.id, { k: "b" });
    const adapter = await getAdapter();
    const now = new Date().toISOString();
    adapter.transaction(() => {
      reserveCredentialByIdSync(adapter, a.id, "ord", "i1", now);
      reserveCredentialByIdSync(adapter, b.id, "ord", "i2", now);
    });

    let released;
    adapter.transaction(() => {
      released = releaseReservationSync(adapter, "ord", new Date().toISOString());
    });
    expect(released).toBe(2);

    const creds = await listCredentials(product.id, {});
    for (const c of creds) {
      expect(c.status).toBe("available");
      expect(c.orderId).toBeNull();
      expect(c.reservedAt).toBeNull();
    }
  });

  it("leaves delivered credentials untouched (only releases reserved)", async () => {
    const product = await seedProduct();
    const cred = await addCredential(product.id, { k: "v" });
    const adapter = await getAdapter();
    const now = new Date().toISOString();
    // Deliver it (terminal-ish state) linked to an order.
    adapter.transaction(() => {
      const picked = getAvailableCredentialSync(adapter, product.id);
      deliverCredentialSync(adapter, picked.id, "ord", "i1", now);
    });

    let released;
    adapter.transaction(() => {
      released = releaseReservationSync(adapter, "ord", new Date().toISOString());
    });
    expect(released).toBe(0);

    const after = await getCredentialById(cred.id);
    expect(after.status).toBe("delivered");
  });

  it("returns 0 when no credentials are linked to the order", async () => {
    const adapter = await getAdapter();
    let released;
    adapter.transaction(() => {
      released = releaseReservationSync(adapter, "no-such-order", new Date().toISOString());
    });
    expect(released).toBe(0);
  });
});
