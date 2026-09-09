/**
 * Admin order list — GET with filters + pagination (Story 2.28 T7, AC2/AC9).
 * Filters: status, userId, productId. Returns pagination metadata (total/limit/offset).
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { listAllOrders, countAllOrders, ORDER_STATUSES } from "@/lib/db/repos/ordersRepo";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const userId = url.searchParams.get("userId");
  const productId = url.searchParams.get("productId");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
  const offset = Number(url.searchParams.get("offset")) || 0;

  if (status && !ORDER_STATUSES.includes(status)) {
    return NextResponse.json({ error: `status không hợp lệ (cho phép: ${ORDER_STATUSES.join(", ")})` }, { status: 422 });
  }

  try {
    const filter = { status, userId, productId, limit, offset };
    const [orders, total] = await Promise.all([
      listAllOrders(filter),
      countAllOrders({ status, userId, productId }),
    ]);
    return NextResponse.json({ orders, total, limit, offset });
  } catch (e) {
    console.error("[api/store/admin/orders] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải danh sách đơn hàng" }, { status: 500 });
  }
}
