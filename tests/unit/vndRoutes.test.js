// Tests for POST /api/payments/vnd and POST /api/payments/vnd-webhook (Story 2-39 / T8)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── static mocks (hoisted before imports) ───────────────────────────────────

const mockDb = {
  get: vi.fn(),
  run: vi.fn(),
  transaction: vi.fn((fn) => fn()),
};

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(() => Promise.resolve(mockDb)),
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: vi.fn(),
}));

vi.mock("@/lib/payment/vndBank.js", () => ({
  isConfigured: vi.fn(),
  generateMemo: vi.fn(() => "9RAABBCCDD"),
  creditsToVnd: vi.fn((c) => c * 1000),
  vndToCredits: vi.fn((v) => Math.floor(v / 1000)),
  generateVietQRUrl: vi.fn(() => "https://img.vietqr.io/image/mock.png"),
  getBankInfo: vi.fn(() => ({ bankName: "VCB", bankBin: "970436", accountNumber: "111", vndPerCredit: 1000 })),
  getPaymentTimeoutMs: vi.fn(() => 30 * 60 * 1000),
  verifyWebhookSecret: vi.fn(),
  createVndPayment: vi.fn(),
}));

vi.mock("@/lib/db/repos/creditLedgerRepo.js", () => ({
  recordCreditTxn: vi.fn(),
}));

vi.mock("@/lib/affiliate/affiliateCommission.js", () => ({
  payAffiliateCommission: vi.fn(),
}));

// ─── module handles (populated in beforeEach) ────────────────────────────────

let vndPOST, vndGET, webhookPOST;
let getDashboardAuthSession;
let isConfigured, verifyWebhookSecret, creditsToVnd, vndToCredits, createVndPayment;
let recordCreditTxn;
let payAffiliateCommission;

beforeEach(async () => {
  vi.resetModules();
  mockDb.get.mockReset();
  mockDb.run.mockReset();
  mockDb.transaction.mockReset();
  mockDb.transaction.mockImplementation((fn) => fn());

  const authMod = await import("@/lib/auth/dashboardSession");
  getDashboardAuthSession = authMod.getDashboardAuthSession;

  const bankMod = await import("@/lib/payment/vndBank.js");
  isConfigured = bankMod.isConfigured;
  verifyWebhookSecret = bankMod.verifyWebhookSecret;
  creditsToVnd = bankMod.creditsToVnd;
  vndToCredits = bankMod.vndToCredits;
  createVndPayment = bankMod.createVndPayment;

  const ledgerMod = await import("@/lib/db/repos/creditLedgerRepo.js");
  recordCreditTxn = ledgerMod.recordCreditTxn;

  const affiliateMod = await import("@/lib/affiliate/affiliateCommission.js");
  payAffiliateCommission = affiliateMod.payAffiliateCommission;

  // Reset all mock implementations to safe defaults
  getDashboardAuthSession.mockResolvedValue({ userId: "user-42" });
  isConfigured.mockReturnValue(true);
  verifyWebhookSecret.mockReturnValue(true);
  creditsToVnd.mockImplementation((c) => c * 1000);
  vndToCredits.mockImplementation((v) => Math.floor(v / 1000));
  createVndPayment.mockImplementation(async ({ userId, credits }) => ({
    id: "pay-mock-id",
    memo: "9RAABBCCDD",
    amountVnd: credits * 1000,
    credits,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    qrUrl: "https://img.vietqr.io/image/mock.png",
    bankInfo: { bankName: "VCB", bankBin: "970436", accountNumber: "111", vndPerCredit: 1000 },
  }));
  recordCreditTxn.mockReturnValue({ id: "txn-1" });
  payAffiliateCommission.mockResolvedValue(undefined);

  const vndMod = await import("@/app/api/payments/vnd/route.js");
  vndPOST = vndMod.POST;
  vndGET = vndMod.GET;

  const webhookMod = await import("@/app/api/payments/vnd-webhook/route.js");
  webhookPOST = webhookMod.POST;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeJsonRequest(body, headers = {}, cookies = {}) {
  return {
    json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
    headers: { get: (name) => headers[name] ?? null },
    cookies: { get: (name) => cookies[name] ? { value: cookies[name] } : undefined },
  };
}

function makeBadJsonRequest(headers = {}, cookies = {}) {
  return {
    json: () => Promise.reject(new SyntaxError("bad json")),
    headers: { get: (name) => headers[name] ?? null },
    cookies: { get: (name) => cookies[name] ? { value: cookies[name] } : undefined },
  };
}

// ─── POST /api/payments/vnd ───────────────────────────────────────────────────

describe("POST /api/payments/vnd", () => {
  it("401 when no session", async () => {
    getDashboardAuthSession.mockResolvedValue(null);
    const req = makeJsonRequest({ credits: 10 });
    const res = await vndPOST(req);
    expect(res.status).toBe(401);
  });

  it("401 when session has no userId", async () => {
    getDashboardAuthSession.mockResolvedValue({});
    const req = makeJsonRequest({ credits: 10 });
    const res = await vndPOST(req);
    expect(res.status).toBe(401);
  });

  it("503 when VND not configured", async () => {
    isConfigured.mockReturnValue(false);
    const req = makeJsonRequest({ credits: 10 });
    const res = await vndPOST(req);
    expect(res.status).toBe(503);
  });

  it("400 on invalid JSON body", async () => {
    const req = makeBadJsonRequest();
    const res = await vndPOST(req);
    expect(res.status).toBe(400);
  });

  it("400 when credits missing", async () => {
    const req = makeJsonRequest({});
    const res = await vndPOST(req);
    expect(res.status).toBe(400);
  });

  it("400 when credits is zero", async () => {
    const req = makeJsonRequest({ credits: 0 });
    const res = await vndPOST(req);
    expect(res.status).toBe(400);
  });

  it("400 when credits is negative", async () => {
    const req = makeJsonRequest({ credits: -5 });
    const res = await vndPOST(req);
    expect(res.status).toBe(400);
  });

  it("400 when credits is Infinity", async () => {
    const req = makeJsonRequest({ credits: Infinity });
    const res = await vndPOST(req);
    expect(res.status).toBe(400);
  });

  it("400 when credits is a string", async () => {
    const req = makeJsonRequest({ credits: "abc" });
    const res = await vndPOST(req);
    expect(res.status).toBe(400);
  });

  it("400 when credits is a float (not integer)", async () => {
    const req = makeJsonRequest({ credits: 1.5 });
    const res = await vndPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("integer");
  });

  it("400 when credits exceeds MAX_VND_CREDITS (1,000,000)", async () => {
    const req = makeJsonRequest({ credits: 1_000_001 });
    const res = await vndPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("1000000");
  });

  it("200 happy path — calls createVndPayment and returns correct shape", async () => {
    const req = makeJsonRequest({ credits: 50 });
    const res = await vndPOST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      paymentId: expect.any(String),
      qrUrl: expect.any(String),
      memo: expect.any(String),
      credits: 50,
      amountVnd: expect.any(Number),
      expiresAt: expect.any(String),
      bankInfo: expect.objectContaining({ bankBin: expect.any(String) }),
    });
    expect(createVndPayment).toHaveBeenCalledWith({ userId: "user-42", credits: 50 });
  });

  it("200 happy path — delegates INSERT to createVndPayment (no direct db.run)", async () => {
    const req = makeJsonRequest({ credits: 10 });
    await vndPOST(req);
    expect(createVndPayment).toHaveBeenCalledWith({ userId: "user-42", credits: 10 });
    // Route no longer calls db.run directly — createVndPayment does that internally.
    expect(mockDb.run).not.toHaveBeenCalled();
  });

  it("200 happy path — amountVnd comes from createVndPayment result", async () => {
    createVndPayment.mockResolvedValue({
      id: "pay-custom", memo: "9RCUSTOM01", amountVnd: 25000, credits: 25,
      expiresAt: "2026-01-01T00:30:00.000Z", qrUrl: "https://img.vietqr.io/image/custom.png",
      bankInfo: { bankName: "VCB", bankBin: "970436", accountNumber: "111", vndPerCredit: 1000 },
    });
    const req = makeJsonRequest({ credits: 25 });
    const res = await vndPOST(req);
    const body = await res.json();
    expect(body.amountVnd).toBe(25000);
    expect(body.paymentId).toBe("pay-custom");
  });
});

// ─── GET /api/payments/vnd ───────────────────────────────────────────────────

describe("GET /api/payments/vnd", () => {
  it("returns configured=true and vndPerCredit from getBankInfo", async () => {
    isConfigured.mockReturnValue(true);
    const res = await vndGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ configured: true, vndPerCredit: 1000 });
  });

  it("returns configured=false when VND not configured", async () => {
    isConfigured.mockReturnValue(false);
    const res = await vndGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(false);
  });
});

// ─── POST /api/payments/vnd-webhook ──────────────────────────────────────────

describe("POST /api/payments/vnd-webhook", () => {
  it("401 when secret missing", async () => {
    verifyWebhookSecret.mockReturnValue(false);
    const req = makeJsonRequest({ transferType: "in", transferAmount: 10000, content: "9RAABBCCDD" });
    const res = await webhookPOST(req);
    expect(res.status).toBe(401);
  });

  it("401 when secret wrong", async () => {
    verifyWebhookSecret.mockReturnValue(false);
    const req = makeJsonRequest(
      { transferType: "in", transferAmount: 10000, content: "9RAABBCCDD" },
      { "X-Sepay-Secret": "wrong" }
    );
    const res = await webhookPOST(req);
    expect(res.status).toBe(401);
  });

  it("{ ok: true } on bad JSON body (parse error)", async () => {
    const req = makeBadJsonRequest({ "X-Sepay-Secret": "correct" });
    const res = await webhookPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("{ ok: true } when transferType != 'in'", async () => {
    const req = makeJsonRequest({ transferType: "out", transferAmount: 10000, content: "9RAABBCCDD" });
    const res = await webhookPOST(req);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(recordCreditTxn).not.toHaveBeenCalled();
  });

  it("{ ok: true } when content has no 9R memo pattern", async () => {
    const req = makeJsonRequest({ transferType: "in", transferAmount: 10000, content: "RANDOM PAYMENT" });
    const res = await webhookPOST(req);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(mockDb.get).not.toHaveBeenCalled();
  });

  it("{ ok: true } when payment not found in DB", async () => {
    mockDb.get.mockReturnValue(null);
    const req = makeJsonRequest({ transferType: "in", transferAmount: 10000, content: "Chuyen tien 9RAABBCCDD" });
    const res = await webhookPOST(req);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(recordCreditTxn).not.toHaveBeenCalled();
  });

  it("{ ok: true, note: 'amount_mismatch' } when transferAmount < amountVnd", async () => {
    mockDb.get.mockReturnValue({ id: "pay-1", userId: "user-1", credits: 10, amountVnd: 10000 });
    const req = makeJsonRequest({ transferType: "in", transferAmount: 5000, content: "9RAABBCCDD" });
    const res = await webhookPOST(req);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, note: "amount_mismatch" });
    expect(mockDb.run).not.toHaveBeenCalled();
  });

  it("happy path — settles payment, credits user, returns { ok: true, credited: N }", async () => {
    const payment = { id: "pay-99", userId: "user-7", credits: 20, amountVnd: 20000 };
    mockDb.get.mockReturnValue(payment);
    recordCreditTxn.mockReturnValue({ id: "txn-99" });

    const req = makeJsonRequest({ transferType: "in", transferAmount: 20000, content: "Ma GD 9RAABBCCDD XYZ" });
    const res = await webhookPOST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ ok: true, credited: 20 });
  });

  it("happy path — calls db.run to UPDATE payment to settled", async () => {
    const payment = { id: "pay-99", userId: "user-7", credits: 20, amountVnd: 20000 };
    mockDb.get.mockReturnValue(payment);

    const req = makeJsonRequest({ transferType: "in", transferAmount: 20000, content: "9RAABBCCDD" });
    await webhookPOST(req);

    const updateCall = mockDb.run.mock.calls.find(([sql]) => sql.includes("UPDATE payments"));
    expect(updateCall).toBeTruthy();
    expect(updateCall[0]).toContain("status = 'settled'");
    expect(updateCall[1][updateCall[1].length - 1]).toBe("pay-99"); // last param = id
  });

  it("credits the AGREED amount (payment.credits), not the transferred amount — overpay gives no bonus", async () => {
    const payment = { id: "pay-op", userId: "user-7", credits: 20, amountVnd: 20000 };
    mockDb.get.mockReturnValue(payment);
    recordCreditTxn.mockReturnValue({ id: "txn-op" });

    // User overpays: sends 50000đ against a 20000đ (20-credit) invoice.
    const req = makeJsonRequest({ transferType: "in", transferAmount: 50000, content: "9RAABBCCDD" });
    const res = await webhookPOST(req);
    const body = await res.json();
    expect(body).toEqual({ ok: true, credited: 20 }); // still 20, not 50
    expect(recordCreditTxn).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 20 }),
      expect.anything()
    );
  });

  it("happy path — calls recordCreditTxn with correct idempotencyKey", async () => {
    const payment = { id: "pay-42", userId: "user-7", credits: 10, amountVnd: 10000 };
    mockDb.get.mockReturnValue(payment);
    recordCreditTxn.mockReturnValue({ id: "txn-42" });

    const req = makeJsonRequest({ transferType: "in", transferAmount: 10000, content: "9RAABBCCDD" });
    await webhookPOST(req);

    expect(recordCreditTxn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-7",
        type: "vnd_topup",
        bucket: "standard",
        amount: 10,
        refId: "pay-42",
        idempotencyKey: "vnd:pay-42",
      }),
      expect.anything() // adapter passed for in-transaction (BP-5) execution
    );
  });

  it("happy path — calls payAffiliateCommission", async () => {
    const payment = { id: "pay-5", userId: "user-5", credits: 5, amountVnd: 5000 };
    mockDb.get.mockReturnValue(payment);
    recordCreditTxn.mockReturnValue({ id: "txn-5" });

    const req = makeJsonRequest({ transferType: "in", transferAmount: 5000, content: "9RAABBCCDD" });
    await webhookPOST(req);

    expect(payAffiliateCommission).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-5", txnId: "txn-5", type: "vnd_topup", amount: 5 })
    );
  });

  it("affiliate error does NOT break the response", async () => {
    const payment = { id: "pay-6", userId: "user-6", credits: 5, amountVnd: 5000 };
    mockDb.get.mockReturnValue(payment);
    recordCreditTxn.mockReturnValue({ id: "txn-6" });
    payAffiliateCommission.mockRejectedValue(new Error("affiliate down"));

    const req = makeJsonRequest({ transferType: "in", transferAmount: 5000, content: "9RAABBCCDD" });
    const res = await webhookPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, credited: 5 });
  });

  it("Authorization Bearer header also accepted as secret", async () => {
    verifyWebhookSecret.mockImplementation((s) => s === "bearer-secret");
    const payment = { id: "pay-7", userId: "user-7", credits: 10, amountVnd: 10000 };
    mockDb.get.mockReturnValue(payment);
    recordCreditTxn.mockReturnValue({ id: "txn-7" });

    const req = makeJsonRequest(
      { transferType: "in", transferAmount: 10000, content: "9RAABBCCDD" },
      { Authorization: "Bearer bearer-secret" }
    );
    const res = await webhookPOST(req);
    expect(res.status).toBe(200);
    expect(verifyWebhookSecret).toHaveBeenCalledWith("bearer-secret");
  });

  it("memo lookup is case-insensitive (lowercase 9r in content)", async () => {
    const payment = { id: "pay-8", userId: "user-8", credits: 10, amountVnd: 10000 };
    mockDb.get.mockReturnValue(payment);
    recordCreditTxn.mockReturnValue({ id: "txn-8" });

    const req = makeJsonRequest({ transferType: "in", transferAmount: 10000, content: "thanh toan 9raabbccdd ok" });
    const res = await webhookPOST(req);
    expect(res.status).toBe(200);
    // DB lookup should use uppercased memo
    const getCall = mockDb.get.mock.calls[0];
    expect(getCall[1][0]).toMatch(/^9R[A-F0-9]{8}$/);
  });
});
