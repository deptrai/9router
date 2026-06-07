// Story 2.8 Task 3 + Story 2.9 Task 4: POST /api/payments/create — provider-agnostic
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth/dashboardSession", () => ({ getDashboardAuthSession: vi.fn() }));
vi.mock("@/lib/auth/requireEmailVerified", () => ({ requireEmailVerified: vi.fn() }));
vi.mock("@/lib/payment/providers/index", () => ({ getActiveProvider: vi.fn() }));
vi.mock("@/lib/db/repos/paymentsRepo", () => ({ createPayment: vi.fn(), updatePayment: vi.fn() }));
vi.mock("@/lib/db/helpers/kvStore", () => ({ makeKv: () => ({ get: () => null, set: () => {} }) }));
vi.mock("@/lib/auth/loginLimiter", () => ({ getClientIp: () => "127.0.0.1" }));

let POST;
let getDashboardAuthSession, requireEmailVerified, getActiveProvider, createPayment, updatePayment;

const mockProvider = { getProviderName: vi.fn(() => "nowpayments"), createInvoice: vi.fn() };

beforeEach(async () => {
  vi.resetModules();
  process.env.CRYPTO_PAYMENT_ENABLED = "true";
  getDashboardAuthSession = (await import("@/lib/auth/dashboardSession")).getDashboardAuthSession;
  requireEmailVerified = (await import("@/lib/auth/requireEmailVerified")).requireEmailVerified;
  getActiveProvider = (await import("@/lib/payment/providers/index")).getActiveProvider;
  getActiveProvider.mockReturnValue(mockProvider);
  createPayment = (await import("@/lib/db/repos/paymentsRepo")).createPayment;
  updatePayment = (await import("@/lib/db/repos/paymentsRepo")).updatePayment;
  POST = (await import("@/app/api/payments/create/route.js")).POST;
  mockProvider.getProviderName.mockReturnValue("nowpayments");
  mockProvider.createInvoice.mockReset();
});

afterEach(() => { delete process.env.CRYPTO_PAYMENT_ENABLED; vi.restoreAllMocks(); });

function makeRequest(body = {}, session = null) {
  const req = {
    cookies: { get: n => n === "auth_token" ? { value: session ? "tok" : null } : null },
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
  if (session) getDashboardAuthSession.mockResolvedValue(session);
  else getDashboardAuthSession.mockResolvedValue(null);
  return req;
}

describe("POST /api/payments/create", () => {
  it("happy path: returns payment info with provider", async () => {
    const session = { userId:"u1", role:"user" };
    requireEmailVerified.mockResolvedValue(true);
    createPayment.mockResolvedValue({ id:"pay-1", userId:"u1", network:"tron", coin:"USDT", amountExpected:10, bonusPercent:15 });
    mockProvider.createInvoice.mockResolvedValue({ gatewayId:"inv-1", paymentUrl:"https://np.io/inv-1", payAddress:"TAddr", amountExpected:10, expiresAt:null });
    updatePayment.mockResolvedValue({});
    const res = await POST(makeRequest({ amount:10, coin:"USDT", network:"tron" }, session));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.paymentId).toBe("pay-1");
    expect(data.provider).toBe("nowpayments");
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ provider:"nowpayments" }));
  });
  it("happy path with bitcart provider", async () => {
    mockProvider.getProviderName.mockReturnValue("bitcart");
    const session = { userId:"u1", role:"user" };
    requireEmailVerified.mockResolvedValue(true);
    createPayment.mockResolvedValue({ id:"pay-2", userId:"u1", network:"tron", coin:"USDT", amountExpected:10, bonusPercent:15 });
    mockProvider.createInvoice.mockResolvedValue({ gatewayId:"bc-inv-1", paymentUrl:"http://bc.local/pay", payAddress:"TAddr", amountExpected:10, expiresAt:null });
    updatePayment.mockResolvedValue({});
    const res = await POST(makeRequest({ amount:10, coin:"USDT", network:"tron" }, session));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.provider).toBe("bitcart");
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ provider:"bitcart" }));
  });
  it("503 when no provider configured", async () => {
    getActiveProvider.mockReturnValue(null);
    requireEmailVerified.mockResolvedValue(true);
    const res = await POST(makeRequest({ amount:10, coin:"USDT", network:"tron" }, { userId:"u1", role:"user" }));
    expect(res.status).toBe(503);
  });
  it("503 when provider.createInvoice throws", async () => {
    requireEmailVerified.mockResolvedValue(true);
    createPayment.mockResolvedValue({ id:"p3", userId:"u1", network:"tron", coin:"USDT", amountExpected:10, bonusPercent:15 });
    mockProvider.createInvoice.mockRejectedValue(new Error("down"));
    updatePayment.mockResolvedValue({});
    expect((await POST(makeRequest({ amount:10, coin:"USDT", network:"tron" }, { userId:"u1", role:"user" }))).status).toBe(503);
  });
  it("401 when no session", async () => {
    expect((await POST(makeRequest({ amount:10, coin:"USDT", network:"tron" }))).status).toBe(401);
  });
  it("403 when role=admin", async () => {
    const res = await POST(makeRequest({ amount:10, coin:"USDT", network:"tron" }, { userId:"a1", role:"admin" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/user role/i);
  });
  it("403 when email not verified", async () => {
    requireEmailVerified.mockResolvedValue(false);
    const res = await POST(makeRequest({ amount:10, coin:"USDT", network:"tron" }, { userId:"u1", role:"user" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/email/i);
  });
  it("503 when CRYPTO_PAYMENT_ENABLED=false", async () => {
    process.env.CRYPTO_PAYMENT_ENABLED = "false";
    vi.resetModules();
    const mod = await import("@/app/api/payments/create/route.js");
    requireEmailVerified.mockResolvedValue(true);
    expect((await mod.POST(makeRequest({ amount:10, coin:"USDT", network:"tron" }, { userId:"u1", role:"user" }))).status).toBe(503);
  });
  it("400 on invalid amount", async () => {
    requireEmailVerified.mockResolvedValue(true);
    expect((await POST(makeRequest({ amount:1, coin:"USDT", network:"tron" }, { userId:"u1", role:"user" }))).status).toBe(400);
  });
  it("400 on unsupported coin", async () => {
    requireEmailVerified.mockResolvedValue(true);
    expect((await POST(makeRequest({ amount:10, coin:"BTC", network:"tron" }, { userId:"u1", role:"user" }))).status).toBe(400);
  });
  it("400 on unsupported network", async () => {
    requireEmailVerified.mockResolvedValue(true);
    expect((await POST(makeRequest({ amount:10, coin:"USDT", network:"avalanche" }, { userId:"u1", role:"user" }))).status).toBe(400);
  });
});
