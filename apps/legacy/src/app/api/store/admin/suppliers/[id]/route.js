/**
 * Admin supplier-source detail (Story 2.34, AC2/QĐ3/QĐ6).
 * GET  — source detail + recent supplierOrders (20) with dual-status context.
 * Admin-only. Auth credentials never returned.
 *
 * Note: source CRUD (PUT/DELETE) + force-sync (POST ?action=sync) live in the existing
 * 2.30 route at /api/store/suppliers/[id]. This 2.34 route is the operations/observability
 * view; it does NOT duplicate CRUD.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getSupplierSourceById } from "@/lib/db/repos/supplierSourcesRepo";
import { listSupplierOrders } from "@/lib/db/repos/supplierOrdersRepo";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const source = await getSupplierSourceById(id);
    if (!source) {
      return NextResponse.json({ error: "Nguồn cung cấp không tồn tại" }, { status: 404 });
    }
    const supplierOrders = await listSupplierOrders({ supplierSourceId: id, limit: 20 });
    return NextResponse.json({ source, supplierOrders });
  } catch (e) {
    console.error("[api/store/admin/suppliers/:id] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải chi tiết nguồn cung cấp" }, { status: 500 });
  }
}
