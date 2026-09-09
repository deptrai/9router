/**
 * Admin manual reconciliation trigger (Story 2.34, AC4-AC6/QĐ1).
 * POST — run reconcileSupplierOrders() now, return flagged counts. Admin-only.
 * Same sweep the scheduled job runs (T6); exposed for on-demand admin use.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { reconcileSupplierOrders } from "@/lib/store/supplierReconciliation";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const counts = await reconcileSupplierOrders();
    return NextResponse.json({ ok: true, ...counts });
  } catch (e) {
    console.error("[api/store/admin/reconcile] lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể chạy reconciliation" }, { status: 500 });
  }
}
