// Story 2.8 Task 4: POST /api/webhooks/crypto (NOWPayments IPN) unit tests
// CRITICAL: double-credit prevention, HMAC verify, idempotency
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { addCredits } from "@/lib/db/repos/usersRepo";

vi.mock("@/lib/db/repos/paymentsRepo", () => ({
  getPaymentByGatewayId: vi.fn(),
  getPaymentById: vi.fn(),
  updatePayment: vi.fn(),
}));
vi.mock("@/lib/db/repos/usersRepo", () => ({
  addCredits: vi.fn(),
}));

// Mock getAdapter with transaction support
const mockDb = {
  get: vi.fn(),
  run: vi.fn(),
  transaction: vi.fn((fn) => fn()),
};
vi.mock("@/lib/db/driver", () => ({
  getAdapter: vi.fn(() => Promise.resolve(mockDb)),
}));

let POST;
let getPaymentByGatewayId, getPaymentById, updatePayment;

const IPN_SECRET = "test-ipn-secret";

function makeSignature(body) {
  const parsed = JSON.parse(body);
  const sorted = JSON.stringify(
    Object.fromEntries(Object.keys(parsed).sort().map((k) => [k, parsed[k]]))
  );
  return createHmac("sha512", IPN_SECRET).update(sorted).digest("hex");
}

function makeRequest(body, sig) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = sig !== undefined ? sig : makeSignature(raw);
  return {
    text: () => Promise.resolve(raw),
    headers: { get: (name) => name === "x-nowpayments-sig" ? signature : null },
  };
}

beforeEach(async () => {
  vi.resetModules();
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;

  // Re-import after mock setup
  const repoMod = await import("@/lib/db/repos/paymentsRepo");
  getPaymentByGatewayId = repoMod.getPaymentByGatewayId;
  getPaymentById = repoMod.getPaymentById;
  updatePayment = repoMod.updatePayment;

  // Need to re-import route fresh (it imports verifyIpnSignature which uses real crypto)
  vi.doUnmock("@/lib/payment/nowpayments");
  const routeMod = await import("@/app/api/webhooks/crypto/route.js");
  POST = routeMod.POST;

  mockDb.get.mockReset();
  mockDb.run.mockReset();
  mockDb.transaction.mockReset();
  mockDb.transaction.mockImplementation((fn) => fn());
});

afterEach(() => {
  delete process.env.NOWPAYMENTS_IPN_SECRET;
  vi.restoreAllMocks();
});

describe("POST /api/webhooks/crypto", () => {
  it("401 on invalid signature", async () => {
    const body = { payment_id: "123", payment_status: "finished" };
    const req = makeRequest(body, "bad-sig");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("401 on malformed JSON body", async () => {
    const req = makeRequest("not-json", "sig");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("401 when IPN_SECRET not set", async () => {
    delete process.env.NOWPAYMENTS_IPN_SECRET;
    vi.resetModules();
    vi.doUnmock("@/lib/payment/nowpayments");
    const mod = await import("@/app/api/webhooks/crypto/route.js");
    const body = { payment_id: "123", payment_status: "finished" };
    const req = makeRequest(body);
    const res = await mod.POST(req);
    expect(res.status).toBe(401);
  });

  it("settled + credits awarded on status=finished", async () => {
    const payment = { id: "pay-1", userId: "u1", status: "confirming", amountExpected: 10, bonusPercent: 15 };
    getPaymentByGatewayId.mockResolvedValue(payment);
    mockDb.get.mockReturnValue({ status: "confirming" }); // fresh check inside txn

    const body = { payment_id: "gw-1", payment_status: "finished", actually_paid: 10, confirmations: 19 };
    const req = makeRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(200);
    // Verify transaction ran (settle + credits)
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.run).toHaveBeenCalledTimes(1); // UPDATE payments
    // Credits awarded via addCredits (10 * 1.15 = 11.5)
    expect(addCredits).toHaveBeenCalledTimes(1);
    expect(addCredits.mock.calls[0][1]).toBeCloseTo(11.5); // creditsToAward
  });

  it("already settled → 200 no-op (NO double credit)", async () => {
    const payment = { id: "pay-1", userId: "u1", status: "settled", amountExpected: 10, bonusPercent: 15 };
    getPaymentByGatewayId.mockResolvedValue(payment);

    const body = { payment_id: "gw-1", payment_status: "finished", actually_paid: 10 };
    const req = makeRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(200);
    // NO transaction, NO db.run (credits NOT awarded again)
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockDb.run).not.toHaveBeenCalled();
  });

  it("confirming → updates payment in a transaction, does NOT award credits", async () => {
    const payment = { id: "pay-1", userId: "u1", status: "pending", amountExpected: 10, amountReceived: null, confirmations: 0, bonusPercent: 15 };
    getPaymentByGatewayId.mockResolvedValue(payment);
    mockDb.get.mockReturnValue({ status: "pending", txHash: null });

    const body = { payment_id: "gw-1", payment_status: "confirming", confirmations: 5 };
    const req = makeRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.run).toHaveBeenCalledTimes(1);
    expect(mockDb.run.mock.calls[0][1]).toEqual(["confirming", 5, null, null, null, expect.any(String), "pay-1"]);
  });

  it("late confirming IPN after settle → no status downgrade", async () => {
    const payment = { id: "pay-1", userId: "u1", status: "confirming", amountExpected: 10, amountReceived: null, confirmations: 0, bonusPercent: 0 };
    getPaymentByGatewayId.mockResolvedValue(payment);
    mockDb.get.mockReturnValue({ status: "settled", txHash: null });

    const body = { payment_id: "gw-1", payment_status: "confirming", confirmations: 5 };
    const req = makeRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.run).not.toHaveBeenCalled();
  });

  it("race condition: concurrent finished → only first settles (txn recheck)", async () => {
    const payment = { id: "pay-1", userId: "u1", status: "confirming", amountExpected: 10, bonusPercent: 0 };
    getPaymentByGatewayId.mockResolvedValue(payment);
    // Inside transaction, fresh check returns "settled" (other worker already settled)
    mockDb.get.mockReturnValue({ status: "settled" });

    const body = { payment_id: "gw-1", payment_status: "finished", actually_paid: 10 };
    const req = makeRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // db.run should NOT be called (early return inside txn)
    expect(mockDb.run).not.toHaveBeenCalled();
  });

  it("DB error → 500 (fail-soft, NOWPayments retries)", async () => {
    getPaymentByGatewayId.mockRejectedValue(new Error("DB down"));

    const body = { payment_id: "gw-1", payment_status: "finished", actually_paid: 10 };
    const req = makeRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(500);
  });
});
