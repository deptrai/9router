/**
 * Admin single markup-rule management — GET + PUT + DELETE (Story 2.31 T5, AC1/AC4).
 * Admin-only (403 otherwise).
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import {
  getMarkupRuleById,
  updateMarkupRule,
  deleteMarkupRule,
  ROUNDING_RULES,
} from "@/lib/db/repos/markupRulesRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const rule = await getMarkupRuleById(id);
    if (!rule) return NextResponse.json({ error: "Markup rule không tồn tại" }, { status: 404 });
    return NextResponse.json({ rule });
  } catch (e) {
    console.error("[api/store/markup-rules/:id] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải markup rule" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  // AC4: nếu cập nhật markupPct, phải > 0.
  if (body.markupPct !== undefined && (typeof body.markupPct !== "number" || isNaN(body.markupPct) || body.markupPct <= 0)) {
    return NextResponse.json(
      { error: "markupPct phải lớn hơn 0 (margin dương bắt buộc)" },
      { status: 422 }
    );
  }
  if (body.roundingRule !== undefined && !ROUNDING_RULES.includes(body.roundingRule)) {
    return NextResponse.json(
      { error: `roundingRule không hợp lệ (cho phép: ${ROUNDING_RULES.join(", ")})` },
      { status: 422 }
    );
  }

  try {
    const existing = await getMarkupRuleById(id);
    if (!existing) return NextResponse.json({ error: "Markup rule không tồn tại" }, { status: 404 });
    const rule = await updateMarkupRule(id, body);
    return NextResponse.json({ rule });
  } catch (e) {
    const msg = e?.message || "";
    if (/markupPct|roundingRule/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 422 });
    }
    console.error("[api/store/markup-rules/:id] PUT lỗi:", msg);
    return NextResponse.json({ error: "Không thể cập nhật markup rule" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const existing = await getMarkupRuleById(id);
    if (!existing) return NextResponse.json({ error: "Markup rule không tồn tại" }, { status: 404 });
    await deleteMarkupRule(id);
    return NextResponse.json({ deleted: true });
  } catch (e) {
    console.error("[api/store/markup-rules/:id] DELETE lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể xoá markup rule" }, { status: 500 });
  }
}
