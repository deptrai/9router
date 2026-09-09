/**
 * Admin: publish all variants in a product group (Story 2-38.2).
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { publishAllVariantsInGroup } from "@/lib/store/markupEngine";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }
  if (!body?.groupId) {
    return NextResponse.json({ error: "groupId là bắt buộc" }, { status: 422 });
  }
  try {
    const result = await publishAllVariantsInGroup(body.groupId);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[api/store/admin/products/publish-group] lỗi:", e?.message);
    return NextResponse.json({ error: e?.message || "Không thể publish group" }, { status: 500 });
  }
}
