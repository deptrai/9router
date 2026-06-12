/**
 * GET /api/store/entitlements — danh sách entitlements của user đang đăng nhập.
 *
 * User-scoped: chỉ trả entitlements thuộc về session.userId. Không cho phép
 * query userId của người khác (tránh IDOR). Optional filter ?status=active.
 *
 * Auth: yêu cầu auth_token cookie hợp lệ (user session). 401 nếu thiếu.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import {
  listEntitlementsByUser,
  ENTITLEMENT_STATUSES,
} from "@/lib/db/repos/entitlementsRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session?.userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  if (status && !ENTITLEMENT_STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status không hợp lệ (cho phép: ${ENTITLEMENT_STATUSES.join(", ")})` },
      { status: 422 }
    );
  }

  try {
    const entitlements = await listEntitlementsByUser(session.userId, status ? { status } : {});
    return NextResponse.json({ entitlements });
  } catch (e) {
    console.error("[api/store/entitlements] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải danh sách entitlements" }, { status: 500 });
  }
}
