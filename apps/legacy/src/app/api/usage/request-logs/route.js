import { NextResponse } from "next/server";
import { getRecentLogs } from "@/lib/usageDb";
import { getSessionRole } from "@/lib/auth/requireRole";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { session, role } = await getSessionRole(request);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const userId = role !== "admin" ? session.userId : null;
    const logs = await getRecentLogs(200, userId);
    return NextResponse.json(logs);
  } catch (error) {
    console.error("Error fetching logs:", error);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
