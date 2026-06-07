// Story 2.9: POST /api/webhooks/bitcart unit tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const saved = {};
const KEYS = ["DATA_DIR","BITCART_WEBHOOK_SECRET","BITCART_BASE_URL","BITCART_API_KEY","BITCART_STORE_ID"];

function makeReq({ body, token } = {}) {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const url = `http://localhost/api/webhooks/bitcart${token ? `?token=${token}` : ""}`;
  return { url, text: async () => rawBody, headers: { get: () => null } };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bcwh-"));
  KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.DATA_DIR = tempDir;
  process.env.BITCART_WEBHOOK_SECRET = "test-secret";
  process.env.BITCART_BASE_URL = "http://bc.local";
  process.env.BITCART_API_KEY = "bc-key";
  process.env.BITCART_STORE_ID = "store-1";
  delete global._dbAdapter;
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

async function seedPayment({ userId="user-wh", gatewayPaymentId="gw-bc-1", status="confirming" } = {}) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  db.run(`INSERT OR IGNORE INTO users(id,email,passwordHash,creditsBalance,createdAt,updatedAt) VALUES(?,?,?,?,?,?)`,
    [userId,`${userId}@test.com`,"hash",0,new Date().toISOString(),new Date().toISOString()]);
  const { createPayment } = await import("@/lib/db/repos/paymentsRepo.js");
  return createPayment({ userId, network:"tron", coin:"USDT", amountExpected:10, bonusPercent:10, status, gatewayPaymentId, provider:"bitcart" });
}

describe("POST /api/webhooks/bitcart", () => {
  it("bad token → 401", async () => {
    const { POST } = await import("@/app/api/webhooks/bitcart/route.js");
    expect((await POST(makeReq({ body:{ id:"inv-1", status:"complete" }, token:"wrong" }))).status).toBe(401);
  });
  it("missing token → 401", async () => {
    const { POST } = await import("@/app/api/webhooks/bitcart/route.js");
    expect((await POST(makeReq({ body:{ id:"inv-1", status:"complete" } }))).status).toBe(401);
  });
  it("valid token + complete → credits added", async () => {
    const payment = await seedPayment({ gatewayPaymentId:"gw-c1" });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    global.fetch.mockResolvedValueOnce({ ok:true, json:async () => ({ id:"gw-c1", payments:[{ amount:10, lookup_field:"0xtx", confirmations:3 }] }) });
    const { POST } = await import("@/app/api/webhooks/bitcart/route.js");
    const res = await POST(makeReq({ body:{ id:"gw-c1", status:"complete" }, token:"test-secret" }));
    expect(res.status).toBe(200);
    expect(db.get(`SELECT status FROM payments WHERE id=?`, [payment.id]).status).toBe("settled");
    expect(db.get(`SELECT creditsBalance FROM users WHERE id=?`, ["user-wh"]).creditsBalance).toBe(11);
  });
  it("duplicate settled → 200 no-op, no double credit", async () => {
    await seedPayment({ gatewayPaymentId:"gw-dup", status:"settled" });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`UPDATE users SET creditsBalance=11 WHERE id=?`, ["user-wh"]);
    const { POST } = await import("@/app/api/webhooks/bitcart/route.js");
    await POST(makeReq({ body:{ id:"gw-dup", status:"complete" }, token:"test-secret" }));
    expect(db.get(`SELECT creditsBalance FROM users WHERE id=?`, ["user-wh"]).creditsBalance).toBe(11);
  });
  it("resolveSettlement throws → 500, no credit", async () => {
    await seedPayment({ gatewayPaymentId:"gw-err" });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    global.fetch.mockRejectedValueOnce(new Error("timeout"));
    const { POST } = await import("@/app/api/webhooks/bitcart/route.js");
    expect((await POST(makeReq({ body:{ id:"gw-err", status:"complete" }, token:"test-secret" }))).status).toBe(500);
    expect(db.get(`SELECT creditsBalance FROM users WHERE id=?`, ["user-wh"]).creditsBalance).toBe(0);
  });
  it("non-complete status → updated, no credit", async () => {
    const payment = await seedPayment({ gatewayPaymentId:"gw-nc", status:"pending" });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const { POST } = await import("@/app/api/webhooks/bitcart/route.js");
    await POST(makeReq({ body:{ id:"gw-nc", status:"confirmed" }, token:"test-secret" }));
    expect(db.get(`SELECT status FROM payments WHERE id=?`, [payment.id]).status).toBe("confirming");
    expect(db.get(`SELECT creditsBalance FROM users WHERE id=?`, ["user-wh"]).creditsBalance).toBe(0);
  });
  it("payment not found → 200 ack", async () => {
    const { POST } = await import("@/app/api/webhooks/bitcart/route.js");
    expect((await POST(makeReq({ body:{ id:"nope", status:"complete" }, token:"test-secret" }))).status).toBe(200);
  });
});
