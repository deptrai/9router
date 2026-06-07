// Story 2.8 Task 5: GET /api/payments and GET /api/payments/[id] unit tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: vi.fn(),
}));
vi.mock("@/lib/db/repos/paymentsRepo", () => ({
  listPayments: vi.fn(),
  getPaymentById: vi.fn(),
}));

let GET_list, GET_single;
let getDashboardAuthSession, listPayments, getPaymentById;

beforeEach(async () => {
  vi.resetModules();

  const sessionMod = await import("@/lib/auth/dashboardSession");
  getDashboardAuthSession = sessionMod.getDashboardAuthSession;

  const repoMod = await import("@/lib/db/repos/paymentsRepo");
  listPayments = repoMod.listPayments;
  getPaymentById = repoMod.getPaymentById;

  const listMod = await import("@/app/api/payments/route.js");
  GET_list = listMod.GET;

  const singleMod = await import("@/app/api/payments/[id]/route.js");
  GET_single = singleMod.GET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeListRequest(query = {}) {
  const params = new URLSearchParams(query).toString();
  return {
    url: `http://localhost/api/payments${params ? "?" + params : ""}`,
    cookies: { get: (n) => n === "auth_token" ? { value: "tok" } : null },
  };
}

function makeRequest(session) {
  return {
    url: "http://localhost/api/payments",
    cookies: { get: (n) => n === "auth_token" ? { value: session ? "tok" : null } : null },
  };
}

describe("GET /api/payments/[id]", () => {
  it("owner can fetch own payment", async () => {
    getDashboardAuthSession.mockResolvedValue({ userId: "u1", role: "user" });
    getPaymentById.mockResolvedValue({ id: "pay-1", userId: "u1", status: "pending" });

    const res = await GET_single(makeRequest({ userId: "u1" }), { params: Promise.resolve({ id: "pay-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("pay-1");
  });

  it("non-owner → 403", async () => {
    getDashboardAuthSession.mockResolvedValue({ userId: "u2", role: "user" });
    getPaymentById.mockResolvedValue({ id: "pay-1", userId: "u1", status: "pending" });

    const res = await GET_single(makeRequest({ userId: "u2" }), { params: Promise.resolve({ id: "pay-1" }) });
    expect(res.status).toBe(403);
  });

  it("admin can fetch any payment", async () => {
    getDashboardAuthSession.mockResolvedValue({ userId: "admin-1", role: "admin" });
    getPaymentById.mockResolvedValue({ id: "pay-1", userId: "u1", status: "settled" });

    const res = await GET_single(makeRequest({ userId: "admin-1" }), { params: Promise.resolve({ id: "pay-1" }) });
    expect(res.status).toBe(200);
  });

  it("not found → 404", async () => {
    getDashboardAuthSession.mockResolvedValue({ userId: "u1", role: "user" });
    getPaymentById.mockResolvedValue(null);

    const res = await GET_single(makeRequest({ userId: "u1" }), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("no session → 401", async () => {
    getDashboardAuthSession.mockResolvedValue(null);

    const res = await GET_single(makeRequest(null), { params: Promise.resolve({ id: "pay-1" }) });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/payments (list)", () => {
  it("user only sees own payments (userId filter applied)", async () => {
    getDashboardAuthSession.mockResolvedValue({ userId: "u1", role: "user" });
    listPayments.mockResolvedValue([{ id: "pay-1", userId: "u1" }]);

    const res = await GET_list(makeListRequest());
    expect(res.status).toBe(200);
    expect(listPayments).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
  });

  it("admin sees all payments (no userId filter)", async () => {
    getDashboardAuthSession.mockResolvedValue({ userId: "admin-1", role: "admin" });
    listPayments.mockResolvedValue([{ id: "pay-1", userId: "u1" }, { id: "pay-2", userId: "u2" }]);

    const res = await GET_list(makeListRequest());
    expect(res.status).toBe(200);
    expect(listPayments).toHaveBeenCalledWith(expect.objectContaining({ userId: undefined }));
  });

  it("status filter passed through", async () => {
    getDashboardAuthSession.mockResolvedValue({ userId: "u1", role: "user" });
    listPayments.mockResolvedValue([]);

    await GET_list(makeListRequest({ status: "settled" }));
    expect(listPayments).toHaveBeenCalledWith(expect.objectContaining({ status: "settled" }));
  });

  it("no session → 401", async () => {
    getDashboardAuthSession.mockResolvedValue(null);

    const res = await GET_list(makeRequest(null));
    expect(res.status).toBe(401);
  });
});
