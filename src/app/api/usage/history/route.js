import { NextResponse } from "next/server";
import { getUsageHistory } from "@/lib/usageDb";
import { getSessionRole } from "@/lib/auth/requireRole";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { session, role } = await getSessionRole(request);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const filter = {
      provider: searchParams.get("provider") || undefined,
      model: searchParams.get("model") || undefined,
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
    };
    if (role !== "admin") filter.userId = session.userId;

    const rows = await getUsageHistory(filter);
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching usage history:", error);
    return NextResponse.json({ error: "Failed to fetch usage history" }, { status: 500 });
  }
}
