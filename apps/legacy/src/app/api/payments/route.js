/**
 * GET /api/payments — Story 2.8 Task 5 (AC5)
 * user: own payments only; admin: all payments. Supports ?limit&offset&status.
 */
import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { listPayments } from "@/lib/db/repos/paymentsRepo";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const token = request.cookies.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = searchParams.get("limit") ?? 20;
  const offset = searchParams.get("offset") ?? 0;
  const status = searchParams.get("status") || undefined;

  const userId = session.role === "admin" ? undefined : session.userId;

  const payments = await listPayments({ userId, status, limit, offset });
  return NextResponse.json(payments);
}
