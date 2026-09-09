import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { requireEmailVerified } from "@/lib/auth/requireEmailVerified";
import { redeemGiftCode } from "@/lib/db/repos/giftCodesRepo";

export const dynamic = "force-dynamic";

// POST /api/gift-codes/redeem — verified role=user only
export async function POST(request) {
  const token = request?.cookies?.get?.("auth_token")?.value;
  const session = await getDashboardAuthSession(token);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only role=user may redeem; admin/legacy tokens are excluded
  if (session.role !== "user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const userId = session.userId;

  // Email verification gate
  const verified = await requireEmailVerified(userId);
  if (!verified) {
    return NextResponse.json({ error: "Email verification required" }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const code = body?.code;
  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "code is required" }, { status: 400 });
  }

  try {
    const result = await redeemGiftCode({ code, userId });
    return NextResponse.json(result);
  } catch (error) {
    const codeMap = {
      NOT_FOUND: [404, "Gift code not found"],
      INACTIVE: [400, "Gift code inactive"],
      EXPIRED: [400, "Gift code expired"],
      EXHAUSTED: [400, "Gift code fully redeemed"],
      ALREADY_REDEEMED: [409, "Gift code already redeemed"],
      INVALID_CODE: [400, "Invalid gift code format"],
    };
    const [status, message] = codeMap[error.code] || [500, "Failed to redeem gift code"];
    if (status === 500) console.error("[API] Failed to redeem gift code:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
