/**
 * Admin supplier operations — list all sources + health + product counts (Story 2.34, AC1/QĐ3).
 * Admin-only. Auth credentials never returned (maskSource handles it).
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { listSupplierSourcesWithCounts } from "@/lib/db/repos/supplierSourcesRepo";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const sources = await listSupplierSourcesWithCounts();
    return NextResponse.json({ sources });
  } catch (e) {
    console.error("[api/store/admin/suppliers] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải danh sách nguồn cung cấp" }, { status: 500 });
  }
}
