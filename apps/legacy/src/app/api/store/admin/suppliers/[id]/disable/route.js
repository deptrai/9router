/**
 * Admin force-disable a supplier source (Story 2.34, AC1/QĐ3).
 * POST — set isActive=0 + status='unhealthy'. Hides products (T4) + fail-closes checkout (T3).
 * Admin-only. Idempotent.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { disableSupplierSource } from "@/lib/db/repos/supplierSourcesRepo";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const source = await disableSupplierSource(id);
    if (!source) {
      return NextResponse.json({ error: "Nguồn cung cấp không tồn tại" }, { status: 404 });
    }
    return NextResponse.json({ source });
  } catch (e) {
    console.error("[api/store/admin/suppliers/:id/disable] lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tắt nguồn cung cấp" }, { status: 500 });
  }
}
