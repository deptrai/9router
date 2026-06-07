// Story 2.8 Task 1: paymentsRepo unit tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-payments-"));
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

describe("paymentsRepo", () => {
  it("createPayment → getPaymentById", async () => {
    const { createPayment, getPaymentById } = await import("@/lib/db/repos/paymentsRepo.js");

    const p = await createPayment({
      userId: "user-1",
      network: "tron",
      coin: "USDT",
      amountExpected: 10.0,
      gatewayPaymentId: "gw-123",
      gatewayInvoiceId: "inv-456",
      payAddress: "TAddr123",
      paymentUrl: "https://nowpayments.io/payment/inv-456",
      bonusPercent: 15,
    });

    expect(p.id).toBeTruthy();
    expect(p.status).toBe("pending");
    expect(p.amountExpected).toBe(10.0);
    expect(p.bonusPercent).toBe(15);

    const fetched = await getPaymentById(p.id);
    expect(fetched.gatewayPaymentId).toBe("gw-123");
    expect(fetched.network).toBe("tron");
    expect(fetched.coin).toBe("USDT");
  });

  it("getPaymentByGatewayId", async () => {
    const { createPayment, getPaymentByGatewayId } = await import("@/lib/db/repos/paymentsRepo.js");

    await createPayment({ userId: "user-1", network: "polygon", coin: "USDC", amountExpected: 5, gatewayPaymentId: "gw-unique" });

    const found = await getPaymentByGatewayId("gw-unique");
    expect(found).not.toBeNull();
    expect(found.coin).toBe("USDC");

    const notFound = await getPaymentByGatewayId("gw-nonexist");
    expect(notFound).toBeNull();
  });

  it("duplicate gatewayPaymentId → throw (UNIQUE)", async () => {
    const { createPayment } = await import("@/lib/db/repos/paymentsRepo.js");

    await createPayment({ userId: "user-1", network: "tron", coin: "USDT", amountExpected: 10, gatewayPaymentId: "dup-gw" });

    await expect(
      createPayment({ userId: "user-2", network: "polygon", coin: "USDC", amountExpected: 5, gatewayPaymentId: "dup-gw" })
    ).rejects.toThrow();
  });

  it("updatePayment merges correctly (filter undefined)", async () => {
    const { createPayment, updatePayment, getPaymentById } = await import("@/lib/db/repos/paymentsRepo.js");

    const p = await createPayment({ userId: "user-1", network: "tron", coin: "USDT", amountExpected: 10, gatewayPaymentId: "upd-gw" });

    const updated = await updatePayment(p.id, { status: "settled", amountReceived: 10.0, creditsAwarded: 11.5, settledAt: "2026-06-07T12:00:00Z" });
    expect(updated.status).toBe("settled");
    expect(updated.amountReceived).toBe(10.0);
    expect(updated.creditsAwarded).toBe(11.5);
    expect(updated.network).toBe("tron"); // preserved

    // undefined doesn't overwrite
    const updated2 = await updatePayment(p.id, { txHash: "0xabc", errorMessage: undefined });
    expect(updated2.txHash).toBe("0xabc");
    expect(updated2.settledAt).toBe("2026-06-07T12:00:00Z"); // preserved
  });

  it("listPayments with filter", async () => {
    const { createPayment, listPayments } = await import("@/lib/db/repos/paymentsRepo.js");

    await createPayment({ userId: "user-A", network: "tron", coin: "USDT", amountExpected: 5, status: "pending", gatewayPaymentId: "a1" });
    await createPayment({ userId: "user-A", network: "polygon", coin: "USDC", amountExpected: 10, status: "settled", gatewayPaymentId: "a2" });
    await createPayment({ userId: "user-B", network: "solana", coin: "USDT", amountExpected: 20, status: "pending", gatewayPaymentId: "b1" });

    const allA = await listPayments({ userId: "user-A" });
    expect(allA.length).toBe(2);

    const settled = await listPayments({ status: "settled" });
    expect(settled.length).toBe(1);
    expect(settled[0].userId).toBe("user-A");

    const all = await listPayments();
    expect(all.length).toBe(3);
  });

  it("exports via barrel", async () => {
    const db = await import("@/lib/db/index.js");
    expect(typeof db.createPayment).toBe("function");
    expect(typeof db.getPaymentById).toBe("function");
    expect(typeof db.getPaymentByGatewayId).toBe("function");
    expect(typeof db.updatePayment).toBe("function");
    expect(typeof db.listPayments).toBe("function");
    expect(typeof db.getPaymentsByUser).toBe("function");
  });

  // --- Review patches (code review 2026-06-07) ---

  it("getPaymentsByUser(falsy) → [] (không leak cross-user)", async () => {
    const { createPayment, getPaymentsByUser } = await import("@/lib/db/repos/paymentsRepo.js");
    await createPayment({ userId: "user-X", network: "tron", coin: "USDT", amountExpected: 5, gatewayPaymentId: "leak-1" });
    await createPayment({ userId: "user-Y", network: "polygon", coin: "USDC", amountExpected: 9, gatewayPaymentId: "leak-2" });

    expect(await getPaymentsByUser(undefined)).toEqual([]);
    expect(await getPaymentsByUser(null)).toEqual([]);
    expect(await getPaymentsByUser("")).toEqual([]);

    const owned = await getPaymentsByUser("user-X");
    expect(owned.length).toBe(1);
    expect(owned[0].userId).toBe("user-X");
  });

  it("updatePayment không throw khi thiếu/null data", async () => {
    const { createPayment, updatePayment } = await import("@/lib/db/repos/paymentsRepo.js");
    const p = await createPayment({ userId: "u", network: "tron", coin: "USDT", amountExpected: 1, gatewayPaymentId: "nd-1" });
    expect(await updatePayment(p.id)).toBeNull();
    expect(await updatePayment(p.id, null)).toBeNull();
    expect(await updatePayment(p.id, {})).toBeNull();
  });

  it("listPayments clamp limit (âm/null → default, không unbounded/empty)", async () => {
    const { createPayment, listPayments } = await import("@/lib/db/repos/paymentsRepo.js");
    for (let i = 0; i < 3; i++) {
      await createPayment({ userId: "u", network: "tron", coin: "USDT", amountExpected: 1, gatewayPaymentId: `lim-${i}` });
    }
    expect((await listPayments({ limit: 2 })).length).toBe(2);    // limit hợp lệ áp dụng
    expect((await listPayments({ limit: -1 })).length).toBe(3);   // âm → fallback default, KHÔNG empty/unbounded
    expect((await listPayments({ limit: null })).length).toBe(3); // null → fallback default
  });
});
