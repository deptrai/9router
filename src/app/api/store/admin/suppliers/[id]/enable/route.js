/**
 * Admin re-enable a supplier source (Story 2.34, AC1/QĐ3).
 * POST — set isActive=1 + status reset to 'active' (unsupported stays unsupported).
 * Admin-only. Idempotent.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { enableSupplierSource } from "@/lib/db/repos/supplierSourcesRepo";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const source = await enableSupplierSource(id);
    if (!source) {
      return NextResponse.json({ error: "Nguồn cung cấp không tồn tại" }, { status: 404 });
    }
    return NextResponse.json({ source });
  } catch (e) {
    console.error("[api/store/admin/suppliers/:id/enable] lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể bật lại nguồn cung cấp" }, { status: 500 });
  }
}
