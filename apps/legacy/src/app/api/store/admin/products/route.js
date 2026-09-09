/**
 * Admin product management — GET (list all) + POST (create) (Story 2.28 T7, AC1/AC9).
 * All handlers require admin (403 otherwise). Never exposes credential payloads.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { listAllProducts, createProduct, PRODUCT_KINDS, DELIVERY_MODES } from "@/lib/db/repos/productsRepo";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const products = await listAllProducts();
    return NextResponse.json({ products });
  } catch (e) {
    console.error("[api/store/admin/products] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải danh sách sản phẩm" }, { status: 500 });
  }
}

export async function POST(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const { name, kind, priceCredits, deliveryMode } = body || {};
  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name bắt buộc" }, { status: 422 });
  }
  if (!PRODUCT_KINDS.includes(kind)) {
    return NextResponse.json({ error: `kind không hợp lệ (cho phép: ${PRODUCT_KINDS.join(", ")})` }, { status: 422 });
  }
  if (!Number.isInteger(priceCredits) || priceCredits < 0) {
    return NextResponse.json({ error: "priceCredits phải là số nguyên >= 0" }, { status: 422 });
  }
  if (!DELIVERY_MODES.includes(deliveryMode)) {
    return NextResponse.json({ error: `deliveryMode không hợp lệ (cho phép: ${DELIVERY_MODES.join(", ")})` }, { status: 422 });
  }

  try {
    const product = await createProduct(body);
    return NextResponse.json({ product }, { status: 201 });
  } catch (e) {
    console.error("[api/store/admin/products] POST lỗi:", e?.message);
    return NextResponse.json({ error: e?.message || "Không thể tạo sản phẩm" }, { status: 500 });
  }
}
