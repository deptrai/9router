/**
 * GET /api/store/products — danh sách sản phẩm active (Story 2.25, D1, AC2)
 *
 * Public read endpoint (đã thêm vào PUBLIC_API_PATHS trong dashboardGuard.js).
 * Không expose dữ liệu nhạy cảm — chỉ trả catalog fields.
 * Cache-Control 30s + stale-while-revalidate để bot không spam DB.
 *
 * ⚠️ Security note: endpoint này public (không cần auth). Intentional — đây là
 * product catalog công khai. Không có thông tin nhạy cảm (inventory chi tiết,
 * cost price, v.v.) trong response. Story 2.28 sẽ thêm admin CRUD có auth.
 */
import { NextResponse } from "next/server";
import { listActiveProducts } from "@/lib/db/repos/productsRepo.js";

export async function GET() {
  try {
    const products = await listActiveProducts();
    const publicProducts = products.map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      description: p.description,
      priceCredits: p.priceCredits,
      deliveryMode: p.deliveryMode,
      stock: p.stock,
      variantCount: p.variantCount,
      bestSupplierName: p.bestSupplierName ?? undefined,
    }));
    return NextResponse.json(
      { products: publicProducts },
      {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
        },
      }
    );
  } catch (e) {
    console.error("[store/products] lỗi:", e?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
