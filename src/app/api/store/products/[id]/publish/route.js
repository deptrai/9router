/**
 * Admin external-product publishing — POST ?action=publish|unpublish|apply-markup (Story 2.31 T5, AC2).
 * Admin-only (403 otherwise).
 *
 * - publish: validates pricing set, then isPublished=1 + isActive=1.
 * - unpublish: isPublished=0 + isActive=0 ("admin lock").
 * - apply-markup: looks up applicable rule, recomputes retailPrice/priceCredits.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getProductById } from "@/lib/db/repos/productsRepo.js";
import {
  publishProduct,
  unpublishProduct,
  applyMarkupToProduct,
} from "@/lib/store/markupEngine.js";

export const dynamic = "force-dynamic";

const ACTIONS = ["publish", "unpublish", "apply-markup"];

export async function POST(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const action = new URL(request.url).searchParams.get("action");
  if (!ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `action không hợp lệ (cho phép: ${ACTIONS.join(", ")})` },
      { status: 422 }
    );
  }

  try {
    const existing = await getProductById(id);
    if (!existing) return NextResponse.json({ error: "Sản phẩm không tồn tại" }, { status: 404 });

    if (action === "apply-markup") {
      const result = await applyMarkupToProduct(id);
      if (!result) {
        return NextResponse.json(
          { error: "Không có markup rule áp dụng cho sản phẩm này" },
          { status: 422 }
        );
      }
      const product = await getProductById(id);
      return NextResponse.json({ product, applied: result });
    }

    if (action === "publish") {
      await publishProduct(id);
    } else {
      await unpublishProduct(id);
    }
    const product = await getProductById(id);
    return NextResponse.json({ product });
  } catch (e) {
    const msg = e?.message || "";
    // publishProduct validation throws (supplierPrice/retailPrice chưa set) → 422 (client sửa được).
    if (/publishProduct:|supplierPrice|retailPrice/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 422 });
    }
    console.error("[api/store/products/:id/publish] POST lỗi:", msg);
    return NextResponse.json({ error: "Không thể thực hiện thao tác" }, { status: 500 });
  }
}
