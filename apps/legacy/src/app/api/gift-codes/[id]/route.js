import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getGiftCodeById, updateGiftCode, disableGiftCode } from "@/lib/db/repos/giftCodesRepo";

export const dynamic = "force-dynamic";

// PATCH /api/gift-codes/[id] — admin only: update gift code (e.g. disable)
export async function PATCH(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const giftCode = await getGiftCodeById(id);
  if (!giftCode) {
    return NextResponse.json({ error: "Gift code not found" }, { status: 404 });
  }

  try {
    if (body?.maxRedemptions !== undefined) {
      const mr = body.maxRedemptions;
      if (!Number.isInteger(mr) || mr < 1) {
        return NextResponse.json({ error: "maxRedemptions must be a positive integer" }, { status: 400 });
      }
    }
    const updated = await updateGiftCode(id, {
      isActive: body?.isActive,
      note: body?.note,
      expiresAt: body?.expiresAt,
      maxRedemptions: body?.maxRedemptions,
    });
    return NextResponse.json({ giftCode: updated });
  } catch (error) {
    console.error("[API] Failed to update gift code:", error);
    return NextResponse.json({ error: "Failed to update gift code" }, { status: 500 });
  }
}

// DELETE /api/gift-codes/[id] — admin only: disable (soft delete)
export async function DELETE(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const giftCode = await getGiftCodeById(id);
  if (!giftCode) {
    return NextResponse.json({ error: "Gift code not found" }, { status: 404 });
  }

  try {
    await disableGiftCode(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[API] Failed to disable gift code:", error);
    return NextResponse.json({ error: "Failed to disable gift code" }, { status: 500 });
  }
}
