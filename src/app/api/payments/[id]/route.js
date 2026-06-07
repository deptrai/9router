/**
 * GET /api/payments/[id] — Story 2.8 Task 5 (AC5)
 * Owner or admin can fetch a single payment by ID.
 */
import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getPaymentById } from "@/lib/db/repos/paymentsRepo";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const token = request.cookies.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const payment = await getPaymentById(id);

  if (!payment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (payment.userId !== session.userId && session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(payment);
}
