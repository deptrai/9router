import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { listGiftCodeRedemptions } from "@/lib/db/repos/giftCodesRepo";

export const dynamic = "force-dynamic";

// GET /api/gift-codes/redemptions — user sees own; admin can filter by userId/giftCodeId
export async function GET(request) {
  const token = request?.cookies?.get?.("auth_token")?.value;
  const session = await getDashboardAuthSession(token);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = searchParams.get("limit");
  const offset = searchParams.get("offset");

  let userId;
  let giftCodeId;

  if (session.role === "user") {
    // Users always see only their own redemptions
    userId = session.userId;
  } else {
    if (session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    userId = searchParams.get("userId") || undefined;
    giftCodeId = searchParams.get("giftCodeId") || undefined;
  }

  try {
    const redemptions = await listGiftCodeRedemptions({
      userId,
      giftCodeId,
      limit: limit ? parseInt(limit, 10) : 10,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return NextResponse.json({ redemptions });
  } catch (error) {
    console.error("[API] Failed to list redemptions:", error);
    return NextResponse.json({ error: "Failed to fetch redemptions" }, { status: 500 });
  }
}
