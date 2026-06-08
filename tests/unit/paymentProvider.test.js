// Story 2.9: provider registry + settlePayment unit tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const saved = {};
const KEYS = ["DATA_DIR","CRYPTO_PAYMENT_PROVIDER","NOWPAYMENTS_API_KEY","BITCART_BASE_URL","BITCART_API_KEY","BITCART_STORE_ID"];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-prov-"));
  KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

describe("getActiveProvider — selection logic", () => {
  it("auto: no config → null", async () => {
    const { getActiveProvider } = await import("@/lib/payment/providers/index.js");
    expect(getActiveProvider()).toBeNull();
  });
  it("auto: NOWPAYMENTS_API_KEY set → nowpayments", async () => {
    process.env.NOWPAYMENTS_API_KEY = "test-key";
    const { getActiveProvider } = await import("@/lib/payment/providers/index.js");
    expect(getActiveProvider().getProviderName()).toBe("nowpayments");
  });
  it("auto: only Bitcart configured → bitcart", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "bc-key";
    process.env.BITCART_STORE_ID = "store-1";
    process.env.BITCART_WEBHOOK_SECRET = "wh-secret";
    const { getActiveProvider } = await import("@/lib/payment/providers/index.js");
    expect(getActiveProvider().getProviderName()).toBe("bitcart");
  });
  it("auto: both configured → nowpayments wins", async () => {
    process.env.NOWPAYMENTS_API_KEY = "np-key";
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "bc-key";
    process.env.BITCART_STORE_ID = "store-1";
    const { getActiveProvider } = await import("@/lib/payment/providers/index.js");
    expect(getActiveProvider().getProviderName()).toBe("nowpayments");
  });
  it("explicit=bitcart → bitcart even if NP key set", async () => {
    process.env.CRYPTO_PAYMENT_PROVIDER = "bitcart";
    process.env.NOWPAYMENTS_API_KEY = "np-key";
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "bc-key";
    process.env.BITCART_STORE_ID = "store-1";
    const { getActiveProvider } = await import("@/lib/payment/providers/index.js");
    expect(getActiveProvider().getProviderName()).toBe("bitcart");
  });
  it("explicit=nowpayments → nowpayments", async () => {
    process.env.CRYPTO_PAYMENT_PROVIDER = "nowpayments";
    process.env.NOWPAYMENTS_API_KEY = "np-key";
    const { getActiveProvider } = await import("@/lib/payment/providers/index.js");
    expect(getActiveProvider().getProviderName()).toBe("nowpayments");
  });
  it("auto: Bitcart missing STORE_ID → null", async () => {
    process.env.BITCART_BASE_URL = "http://bc.local";
    process.env.BITCART_API_KEY = "bc-key";
    const { getActiveProvider } = await import("@/lib/payment/providers/index.js");
    expect(getActiveProvider()).toBeNull();
  });
});

describe("settlePayment", () => {
  async function setup() {
    const { createPayment } = await import("@/lib/db/repos/paymentsRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT OR IGNORE INTO users(id,email,passwordHash,creditsBalance,createdAt,updatedAt) VALUES(?,?,?,?,?,?)`,
      ["u-settle","s@t.com","h",0,new Date().toISOString(),new Date().toISOString()]);
    const payment = await createPayment({ userId:"u-settle", network:"tron", coin:"USDT", amountExpected:10, bonusPercent:10, status:"confirming", gatewayPaymentId:"gw-s1" });
    return { db, payment };
  }

  it("settle → credits added atomically", async () => {
    const { db, payment } = await setup();
    const { settlePayment } = await import("@/lib/payment/settle.js");
    await settlePayment(payment, { amountReceived:10, txHash:"0xabc", confirmations:3 }, db);
    const row = db.get(`SELECT * FROM payments WHERE id=?`, [payment.id]);
    expect(row.status).toBe("settled");
    expect(row.creditsAwarded).toBe(11);
    expect(db.get(`SELECT creditsBalance FROM users WHERE id=?`, ["u-settle"]).creditsBalance).toBe(11);
  });

  it("already settled → no-op, no double credit", async () => {
    const { db, payment } = await setup();
    const { settlePayment } = await import("@/lib/payment/settle.js");
    await settlePayment(payment, { amountReceived:10, txHash:"0xabc", confirmations:3 }, db);
    await settlePayment(payment, { amountReceived:10, txHash:"0xabc", confirmations:3 }, db);
    expect(db.get(`SELECT creditsBalance FROM users WHERE id=?`, ["u-settle"]).creditsBalance).toBe(11);
  });

  it("terminal non-settled (expired) → not overwritten", async () => {
    const { db, payment } = await setup();
    const { updatePayment } = await import("@/lib/db/repos/paymentsRepo.js");
    const { settlePayment } = await import("@/lib/payment/settle.js");
    await updatePayment(payment.id, { status:"expired" });
    await settlePayment(payment, { amountReceived:10, txHash:"0xabc", confirmations:0 }, db);
    expect(db.get(`SELECT status FROM payments WHERE id=?`, [payment.id]).status).toBe("expired");
    expect(db.get(`SELECT creditsBalance FROM users WHERE id=?`, ["u-settle"]).creditsBalance).toBe(0);
  });
});
