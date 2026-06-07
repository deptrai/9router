// Story 2.8 Task 3: POST /api/payments/create unit tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing route
vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: vi.fn(),
}));
vi.mock("@/lib/auth/requireEmailVerified", () => ({
  requireEmailVerified: vi.fn(),
}));
vi.mock("@/lib/payment/nowpayments", () => ({
  createInvoice: vi.fn(),
}));
vi.mock("@/lib/db/repos/paymentsRepo", () => ({
  createPayment: vi.fn(),
  updatePayment: vi.fn(),
}));
vi.mock("@/lib/db/helpers/kvStore", () => ({
  makeKv: () => ({ get: () => null, set: () => {} }),
}));
vi.mock("@/lib/auth/loginLimiter", () => ({
  getClientIp: () => "127.0.0.1",
}));

let POST;
let getDashboardAuthSession, requireEmailVerified, createInvoice, createPayment, updatePayment;

beforeEach(async () => {
  vi.resetModules();
  process.env.NOWPAYMENTS_API_KEY = "test-key";
  process.env.CRYPTO_PAYMENT_ENABLED = "true";

  const sessionMod = await import("@/lib/auth/dashboardSession");
  getDashboardAuthSession = sessionMod.getDashboardAuthSession;

  const emailMod = await import("@/lib/auth/requireEmailVerified");
  requireEmailVerified = emailMod.requireEmailVerified;

  const npMod = await import("@/lib/payment/nowpayments");
  createInvoice = npMod.createInvoice;

  const repoMod = await import("@/lib/db/repos/paymentsRepo");
  createPayment = repoMod.createPayment;
  updatePayment = repoMod.updatePayment;

  const routeMod = await import("@/app/api/payments/create/route.js");
  POST = routeMod.POST;
});

afterEach(() => {
  delete process.env.NOWPAYMENTS_API_KEY;
  delete process.env.CRYPTO_PAYMENT_ENABLED;
  vi.restoreAllMocks();
});

function makeRequest(body = {}, session = null) {
  const req = {
    cookies: { get: (name) => name === "auth_token" ? { value: session ? "tok" : null } : null },
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
  if (session) getDashboardAuthSession.mockResolvedValue(session);
  else getDashboardAuthSession.mockResolvedValue(null);
  return req;
}

describe("POST /api/payments/create", () => {
  it("happy path: creates invoice + returns payment info", async () => {
    const session = { userId: "u1", role: "user" };
    const req = makeRequest({ amount: 10, coin: "USDT", network: "tron" }, session);
    requireEmailVerified.mockResolvedValue(true);
    createPayment.mockResolvedValue({ id: "pay-1", userId: "u1", network: "tron", coin: "USDT", amountExpected: 10 });
    createInvoice.mockResolvedValue({ id: "inv-1", invoice_url: "https://np.io/inv-1", pay_address: "TAddr" });
    updatePayment.mockResolvedValue({});

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.paymentId).toBe("pay-1");
    expect(data.paymentUrl).toBe("https://np.io/inv-1");
    expect(data.coin).toBe("USDT");
  });

  it("401 when no session", async () => {
    const req = makeRequest({ amount: 10, coin: "USDT", network: "tron" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("403 when role !== user (admin)", async () => {
    const req = makeRequest({ amount: 10, coin: "USDT", network: "tron" }, { userId: "a1", role: "admin" });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/user role/i);
  });

  it("403 when email not verified", async () => {
    const req = makeRequest({ amount: 10, coin: "USDT", network: "tron" }, { userId: "u1", role: "user" });
    requireEmailVerified.mockResolvedValue(false);
    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/email/i);
  });

  it("503 when CRYPTO_PAYMENT_ENABLED=false", async () => {
    process.env.CRYPTO_PAYMENT_ENABLED = "false";
    // re-import to pick up env change
    vi.resetModules();
    const mod = await import("@/app/api/payments/create/route.js");
    const session = { userId: "u1", role: "user" };
    const req = makeRequest({ amount: 10, coin: "USDT", network: "tron" }, session);
    requireEmailVerified.mockResolvedValue(true);
    const res = await mod.POST(req);
    expect(res.status).toBe(503);
  });

  it("400 on invalid amount (too low)", async () => {
    const req = makeRequest({ amount: 1, coin: "USDT", network: "tron" }, { userId: "u1", role: "user" });
    requireEmailVerified.mockResolvedValue(true);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/amount/i);
  });

  it("400 on unsupported coin", async () => {
    const req = makeRequest({ amount: 10, coin: "BTC", network: "tron" }, { userId: "u1", role: "user" });
    requireEmailVerified.mockResolvedValue(true);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/coin/i);
  });

  it("400 on unsupported network", async () => {
    const req = makeRequest({ amount: 10, coin: "USDT", network: "avalanche" }, { userId: "u1", role: "user" });
    requireEmailVerified.mockResolvedValue(true);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/network/i);
  });
});
