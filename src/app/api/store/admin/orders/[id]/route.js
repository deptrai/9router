/**
 * Admin single-order management — GET (detail) + PATCH (fulfill|cancel).
 * Story 2.28 T7, AC2/AC3/AC4/AC9.
 *
 * PATCH body: { action: "fulfill" | "cancel", credentialId?, note? }
 *   - fulfill: completes a paid order; optional credentialId reserves+delivers a specific
 *     credential and pushes it to the buyer over Telegram (payload never in the response).
 *   - cancel: releases any reserved credential and marks the order cancelled (no refund).
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getOrderWithItems } from "@/lib/db/repos/ordersRepo";
import { getSupplierOrderByOrderId } from "@/lib/db/repos/supplierOrdersRepo";
import { fulfillOrder, cancelOrder, FulfillError } from "@/lib/store/adminFulfill";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const order = await getOrderWithItems(id);
    if (!order) return NextResponse.json({ error: "Đơn hàng không tồn tại" }, { status: 404 });
    // Story 2.34 (AC2/QĐ6): for external orders, attach the supplier-side tracking row so
    // the admin sees internal status + supplier status (dual-status) + margin side-by-side.
    // Local orders have no supplierOrders row → supplierOrder stays null.
    const supplierOrder = await getSupplierOrderByOrderId(id);
    return NextResponse.json({ order, supplierOrder });
  } catch (e) {
    console.error("[api/store/admin/orders/:id] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải đơn hàng" }, { status: 500 });
  }
}

const FULFILL_ERROR_STATUS = {
  ORDER_NOT_FOUND: 404,
  INVALID_STATE: 409,
  CREDENTIAL_UNAVAILABLE: 409,
};

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

  const { action, credentialId = null, note = null } = body || {};
  if (action !== "fulfill" && action !== "cancel") {
    return NextResponse.json({ error: 'action phải là "fulfill" hoặc "cancel"' }, { status: 422 });
  }

  try {
    if (action === "fulfill") {
      const result = await fulfillOrder(id, { credentialId, note, adminSession: session });
      return NextResponse.json(result);
    }
    const result = await cancelOrder(id, { note });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof FulfillError) {
      const code = FULFILL_ERROR_STATUS[e.code] ?? 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status: code });
    }
    console.error("[api/store/admin/orders/:id] PATCH lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể xử lý đơn hàng" }, { status: 500 });
  }
}
