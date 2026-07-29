import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status ?? 200,
    json: async () => body,
  })),
  listActiveProducts: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: mocks.jsonResponse,
  },
}));

vi.mock("@/lib/db/repos/productsRepo.js", () => ({
  listActiveProducts: mocks.listActiveProducts,
}));

describe("GET /api/store/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("exposes bestSupplierName in the public product list", async () => {
    mocks.listActiveProducts.mockResolvedValue([
      {
        id: "prod-1",
        kind: "account",
        name: "Telegram Premium",
        description: "1 month",
        priceCredits: 100,
        deliveryMode: "instant",
        stock: 5,
        variantCount: 2,
        bestSupplierName: "Supplier A",
      },
      {
        id: "prod-2",
        kind: "account",
        name: "Telegram Premium",
        description: "3 months",
        priceCredits: 250,
        deliveryMode: "instant",
        stock: null,
        variantCount: 2,
        bestSupplierName: null,
      },
    ]);

    const { GET } = await import("@/app/api/store/products/route.js");
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toHaveLength(2);
    expect(body.products[0].bestSupplierName).toBe("Supplier A");
    expect(body.products[1].bestSupplierName).toBeUndefined();
    expect(mocks.listActiveProducts).toHaveBeenCalledTimes(1);
  });
});
