import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getConnectionUsageStats } from "@/lib/usageDb";
import { getSessionRole } from "@/lib/auth/requireRole";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/connection/:id — aggregated usage stats per-connection.
 * Auth: dashboardGuard (getSessionRole) + owner check (chống IDOR).
 * Trả { connectionId, name, provider, stats }.
 */
export async function GET(request, { params }) {
  try {
    const { session, role } = await getSessionRole(request);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Chống IDOR: non-admin chỉ xem được connection thuộc sở hữu (ownerUserId match).
    // ownerUserId = null = shared admin pool → admin thấy hết, user không thấy.
    if (role !== "admin") {
      if (connection.ownerUserId && connection.ownerUserId !== session.userId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const stats = await getConnectionUsageStats(id);
    return NextResponse.json({
      connectionId: id,
      name: connection.name || connection.email || id,
      provider: connection.provider,
      stats,
    });
  } catch (error) {
    console.error("[API] Failed to get connection usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
