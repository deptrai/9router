// Tests for src/lib/payment/vndExpirySweep.js (Story 2-39 / AC7)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-vndSweep-"));
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

// ─── helpers ─────────────────────────────────────────────────────────────────

async function getDb() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  return getAdapter();
}

async function insertPayment(db, opts) {
  const id = opts.id || ("pay-" + Math.random().toString(36).slice(2));
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO payments (id, userId, network, coin, amountExpected, method, status, credits, amountVnd, memo, expiresAt, createdAt, updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      opts.userId || "user-1",
      "vnd",
      "VND",
      0,
      opts.method || "vnd_bank",
      opts.status || "pending",
      opts.credits || 10,
      opts.amountVnd || 10000,
      opts.memo || "9RABCD1234",
      opts.expiresAt || now,
      now,
      now,
    ]
  );
  return id;
}

// ─── expireVndPayments ────────────────────────────────────────────────────────

describe("expireVndPayments", () => {
  it("returns 0 when no payments exist", async () => {
    const { expireVndPayments } = await import("@/lib/payment/vndExpirySweep.js");
    const count = await expireVndPayments();
    expect(count).toBe(0);
  });

  it("expires a single overdue pending vnd_bank payment", async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertPayment(db, { status: "pending", method: "vnd_bank", expiresAt: past });

    const { expireVndPayments } = await import("@/lib/payment/vndExpirySweep.js");
    const count = await expireVndPayments();
    expect(count).toBe(1);
  });

  it("sets status to 'expired' on expired row", async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 60_000).toISOString();
    const id = await insertPayment(db, { id: "exp-1", status: "pending", method: "vnd_bank", expiresAt: past });

    const { expireVndPayments } = await import("@/lib/payment/vndExpirySweep.js");
    await expireVndPayments();

    const row = db.get(`SELECT status FROM payments WHERE id = ?`, [id]);
    expect(row.status).toBe("expired");
  });

  it("does not touch a pending payment whose expiresAt is in the future", async () => {
    const db = await getDb();
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    const id = await insertPayment(db, { id: "fut-1", status: "pending", method: "vnd_bank", expiresAt: future });

    const { expireVndPayments } = await import("@/lib/payment/vndExpirySweep.js");
    const count = await expireVndPayments();

    expect(count).toBe(0);
    const row = db.get(`SELECT status FROM payments WHERE id = ?`, [id]);
    expect(row.status).toBe("pending");
  });

  it("does not expire already-confirmed payments", async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 60_000).toISOString();
    const id = await insertPayment(db, { id: "conf-1", status: "confirmed", method: "vnd_bank", expiresAt: past });

    const { expireVndPayments } = await import("@/lib/payment/vndExpirySweep.js");
    const count = await expireVndPayments();

    expect(count).toBe(0);
    const row = db.get(`SELECT status FROM payments WHERE id = ?`, [id]);
    expect(row.status).toBe("confirmed");
  });

  it("does not expire non-vnd_bank payments", async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 60_000).toISOString();
    const id = await insertPayment(db, { id: "crypto-1", status: "pending", method: "nowpayments", expiresAt: past });

    const { expireVndPayments } = await import("@/lib/payment/vndExpirySweep.js");
    const count = await expireVndPayments();

    expect(count).toBe(0);
    const row = db.get(`SELECT status FROM payments WHERE id = ?`, [id]);
    expect(row.status).toBe("pending");
  });

  it("expires multiple overdue payments in one sweep", async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertPayment(db, { id: "p1", status: "pending", method: "vnd_bank", expiresAt: past, memo: "9RAAAABBBB" });
    await insertPayment(db, { id: "p2", status: "pending", method: "vnd_bank", expiresAt: past, memo: "9RBBBBCCCC" });
    await insertPayment(db, { id: "p3", status: "pending", method: "vnd_bank", expiresAt: past, memo: "9RCCCCDDDD" });

    const { expireVndPayments } = await import("@/lib/payment/vndExpirySweep.js");
    const count = await expireVndPayments();
    expect(count).toBe(3);
  });

  it("only expires overdue ones when mix of past and future exist", async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    await insertPayment(db, { id: "old-1", status: "pending", method: "vnd_bank", expiresAt: past, memo: "9RAAAAAAAA" });
    await insertPayment(db, { id: "new-1", status: "pending", method: "vnd_bank", expiresAt: future, memo: "9RBBBBBBBB" });

    const { expireVndPayments } = await import("@/lib/payment/vndExpirySweep.js");
    const count = await expireVndPayments();
    expect(count).toBe(1);

    const old = db.get(`SELECT status FROM payments WHERE id = ?`, ["old-1"]);
    const fresh = db.get(`SELECT status FROM payments WHERE id = ?`, ["new-1"]);
    expect(old.status).toBe("expired");
    expect(fresh.status).toBe("pending");
  });

  it("is idempotent — second sweep returns 0 for already-expired rows", async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertPayment(db, { status: "pending", method: "vnd_bank", expiresAt: past });

    const { expireVndPayments } = await import("@/lib/payment/vndExpirySweep.js");
    await expireVndPayments();
    const second = await expireVndPayments();
    expect(second).toBe(0);
  });
});
