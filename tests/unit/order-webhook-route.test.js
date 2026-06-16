import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status ?? 200,
    json: async () => body,
  })),
  getSupplierSourceWithAuth: vi.fn(),
  applyOrderStatusEvent: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: mocks.jsonResponse,
  },
}));

vi.mock("@/lib/db/repos/supplierSourcesRepo.js", () => ({
  getSupplierSourceWithAuth: mocks.getSupplierSourceWithAuth,
}));

vi.mock("@/lib/store/orderStatusSync.js", () => ({
  applyOrderStatusEvent: mocks.applyOrderStatusEvent,
}));

const { POST } = await import(
  "@/app/api/store/suppliers/order-webhook/[id]/route.js"
);

const VALID_SECRET = "test-webhook-secret-abc123";

function makeSource(overrides = {}) {
  return {
    id: "src-1",
    syncMode: "webhook",
    auth: { webhookSecret: VALID_SECRET },
    ...overrides,
  };
}

function makeRequest({
  sourceId = "src-1",
  secret = VALID_SECRET,
  headerSecret = true,
  body = { supplierOrderId: "order-99", status: "delivered" },
  rawBody = null,
} = {}) {
  const headers = {};
  if (headerSecret && secret !== null) {
    headers["x-webhook-secret"] = secret;
  }
  const bodyStr = rawBody !== null ? rawBody : JSON.stringify(body);
  const req = new Request(
    `http://localhost/api/store/suppliers/order-webhook/${sourceId}`,
    { method: "POST", headers, body: bodyStr }
  );
  return { req, params: Promise.resolve({ id: sourceId }) };
}

describe("POST /api/store/suppliers/order-webhook/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("[P1] 401 — wrong secret", async () => {
    mocks.getSupplierSourceWithAuth.mockResolvedValue(makeSource());
    const { req, params } = makeRequest({ secret: "wrong-secret" });

    const res = await POST(req, { params });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Invalid webhook secret" });
    expect(mocks.applyOrderStatusEvent).not.toHaveBeenCalled();
  });

  it("[P1] 401 — missing secret header", async () => {
    mocks.getSupplierSourceWithAuth.mockResolvedValue(makeSource());
    const { req, params } = makeRequest({ headerSecret: false, secret: null });

    const res = await POST(req, { params });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Invalid webhook secret" });
  });

  it("[P1] 401 — source not found (unknown id)", async () => {
    mocks.getSupplierSourceWithAuth.mockResolvedValue(null);
    const { req, params } = makeRequest({ sourceId: "unknown-id" });

    const res = await POST(req, { params });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Invalid webhook secret" });
  });

  it("[P1] 401 — syncMode !== 'webhook' (polling source)", async () => {
    mocks.getSupplierSourceWithAuth.mockResolvedValue(
      makeSource({ syncMode: "polling" })
    );
    const { req, params } = makeRequest();

    const res = await POST(req, { params });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Invalid webhook secret" });
  });

  it("[P1] 400 — missing supplierOrderId field", async () => {
    mocks.getSupplierSourceWithAuth.mockResolvedValue(makeSource());
    const { req, params } = makeRequest({
      body: { status: "delivered" },
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Missing required fields: supplierOrderId, status",
    });
    expect(mocks.applyOrderStatusEvent).not.toHaveBeenCalled();
  });

  it("[P1] 400 — missing status field", async () => {
    mocks.getSupplierSourceWithAuth.mockResolvedValue(makeSource());
    const { req, params } = makeRequest({
      body: { supplierOrderId: "order-99" },
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Missing required fields: supplierOrderId, status",
    });
  });

  it("[P1] 400 — invalid JSON body", async () => {
    mocks.getSupplierSourceWithAuth.mockResolvedValue(makeSource());
    const { req, params } = makeRequest({ rawBody: "not-json{{" });

    const res = await POST(req, { params });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid JSON body" });
  });

  it("[P1] 200 — happy path", async () => {
    mocks.getSupplierSourceWithAuth.mockResolvedValue(makeSource());
    mocks.applyOrderStatusEvent.mockResolvedValue({
      ok: true,
      supplierOrderId: "order-99",
      status: "delivered",
    });
    const { req, params } = makeRequest();

    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(mocks.applyOrderStatusEvent).toHaveBeenCalledWith(
      "src-1",
      { supplierOrderId: "order-99", status: "delivered", delivery: undefined }
    );
  });

  it("[P1] 422 — applyOrderStatusEvent returns ok:false", async () => {
    mocks.getSupplierSourceWithAuth.mockResolvedValue(makeSource());
    mocks.applyOrderStatusEvent.mockResolvedValue({
      ok: false,
      error: "Supplier order not found",
    });
    const { req, params } = makeRequest();

    const res = await POST(req, { params });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "Supplier order not found" });
  });

  it("[P1] 500 — applyOrderStatusEvent throws", async () => {
    mocks.getSupplierSourceWithAuth.mockResolvedValue(makeSource());
    mocks.applyOrderStatusEvent.mockRejectedValue(new Error("DB crash"));
    const { req, params } = makeRequest();

    const res = await POST(req, { params });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: "Không thể xử lý order status event",
    });
  });
});
