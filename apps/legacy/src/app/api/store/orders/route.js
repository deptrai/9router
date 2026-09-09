import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { listOrdersByUser } from "@/lib/db/repos/ordersRepo.js";

export async function GET(request) {
  const session = await getDashboardAuthSession(request);
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") || 50);
    const offset = Number(url.searchParams.get("offset") || 0);

    const orders = await listOrdersByUser(session.userId, { limit, offset });
    return NextResponse.json({ orders });
  } catch (e) {
    console.error("[api/store/orders] error:", e.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
