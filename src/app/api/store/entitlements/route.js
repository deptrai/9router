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
import { linkConnectionToEntitlement } from "@/lib/db/repos/connectionsRepo.js";

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

/**
 * POST /api/store/entitlements — link một providerConnection của user vào
 * entitlement đang `pending_connection` để kích hoạt (AC2).
 *
 * Body: { entitlementId, connectionId }
 * User-scoped: linkConnectionToEntitlement tự kiểm tra entitlement thuộc về
 * session.userId (ownership guard) + trạng thái hợp lệ. 401 nếu thiếu auth.
 */
export async function POST(request) {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session?.userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const entitlementId = body?.entitlementId;
  const connectionId = body?.connectionId;
  if (!entitlementId || !connectionId) {
    return NextResponse.json(
      { error: "Cần entitlementId và connectionId" },
      { status: 400 }
    );
  }

  try {
    const result = await linkConnectionToEntitlement(connectionId, entitlementId, session.userId);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e?.message || "";
    // Ownership / status / not-found guard → 422 (client sửa input được).
    if (/không thuộc về|illegal transition|not found|đã thuộc về user khác/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 422 });
    }
    console.error("[api/store/entitlements] POST lỗi:", msg);
    return NextResponse.json({ error: "Không thể kết nối entitlement" }, { status: 500 });
  }
}
