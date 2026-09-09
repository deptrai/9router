/**
 * Admin single-product management — GET + PATCH + DELETE (Story 2.28 T7, AC1/AC9).
 * DELETE is guarded: a product with existing orders cannot be deleted (409) to preserve
 * order-history snapshots — admin should set isActive=false instead.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import {
  getProductById,
  updateProduct,
  deleteProduct,
  productHasOrders,
  PRODUCT_KINDS,
  DELIVERY_MODES,
} from "@/lib/db/repos/productsRepo";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const product = await getProductById(id);
    if (!product) return NextResponse.json({ error: "Sản phẩm không tồn tại" }, { status: 404 });
    return NextResponse.json({ product });
  } catch (e) {
    console.error("[api/store/admin/products/:id] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải sản phẩm" }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  // Validate only the fields actually present (partial update).
  if (body.kind !== undefined && !PRODUCT_KINDS.includes(body.kind)) {
    return NextResponse.json({ error: `kind không hợp lệ (cho phép: ${PRODUCT_KINDS.join(", ")})` }, { status: 422 });
  }
  if (body.deliveryMode !== undefined && !DELIVERY_MODES.includes(body.deliveryMode)) {
    return NextResponse.json({ error: `deliveryMode không hợp lệ (cho phép: ${DELIVERY_MODES.join(", ")})` }, { status: 422 });
  }
  if (body.priceCredits !== undefined && (!Number.isInteger(body.priceCredits) || body.priceCredits < 0)) {
    return NextResponse.json({ error: "priceCredits phải là số nguyên >= 0" }, { status: 422 });
  }

  try {
    const existing = await getProductById(id);
    if (!existing) return NextResponse.json({ error: "Sản phẩm không tồn tại" }, { status: 404 });

    // Do not allow changing kind once the product has orders (snapshot integrity).
    if (body.kind !== undefined && body.kind !== existing.kind && (await productHasOrders(id))) {
      return NextResponse.json(
        { error: "Không thể đổi kind của sản phẩm đã có đơn hàng." },
        { status: 409 }
      );
    }

    const product = await updateProduct(id, body);
    return NextResponse.json({ product });
  } catch (e) {
    console.error("[api/store/admin/products/:id] PATCH lỗi:", e?.message);
    return NextResponse.json({ error: e?.message || "Không thể cập nhật sản phẩm" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const existing = await getProductById(id);
    if (!existing) return NextResponse.json({ error: "Sản phẩm không tồn tại" }, { status: 404 });

    if (await productHasOrders(id)) {
      return NextResponse.json(
        { error: "Sản phẩm đã có đơn hàng, không thể xoá. Hãy set isActive=false." },
        { status: 409 }
      );
    }

    await deleteProduct(id);
    return NextResponse.json({ deleted: true });
  } catch (e) {
    console.error("[api/store/admin/products/:id] DELETE lỗi:", e?.message);
    return NextResponse.json({ error: e?.message || "Không thể xoá sản phẩm" }, { status: 500 });
  }
}
