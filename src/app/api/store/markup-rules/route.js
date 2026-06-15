/**
 * Admin markup-rule management — GET (list) + POST (create) (Story 2.31 T5, AC1/AC4).
 * Admin-only (403 otherwise). Markup rules control retail pricing for external products.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import {
  createMarkupRule,
  listMarkupRules,
  ROUNDING_RULES,
} from "@/lib/db/repos/markupRulesRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const rules = await listMarkupRules();
    return NextResponse.json({ rules });
  } catch (e) {
    console.error("[api/store/markup-rules] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải danh sách markup rule" }, { status: 500 });
  }
}

export async function POST(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  // AC4: markupPct phải > 0 (margin dương bắt buộc). Validate sớm ở route để trả 422.
  if (typeof body?.markupPct !== "number" || isNaN(body.markupPct) || body.markupPct <= 0) {
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
    const rule = await createMarkupRule(body);
    return NextResponse.json({ rule }, { status: 201 });
  } catch (e) {
    // Validation throws from the repo → 422; anything else → 500.
    const msg = e?.message || "";
    if (/markupPct|roundingRule/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 422 });
    }
    console.error("[api/store/markup-rules] POST lỗi:", msg);
    return NextResponse.json({ error: "Không thể tạo markup rule" }, { status: 500 });
  }
}
