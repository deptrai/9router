import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getAdapter } from "@/lib/db/driver.js";

const PERIOD_MS = {
  today: 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "60d": 60 * 24 * 60 * 60 * 1000,
};

async function getSessionUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session || session.role !== "user") return null;
  return session;
}

export async function GET(request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Forbidden — user role required" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "30d";
  const periodMs = PERIOD_MS[period] ?? PERIOD_MS["30d"];
  const since = new Date(Date.now() - periodMs).toISOString();

  try {
    const adapter = await getAdapter();
    const rows = adapter.all(
      `SELECT bucket, COALESCE(SUM(ABS(amount)), 0) AS spent
       FROM creditTransactions
       WHERE userId = ? AND type = 'usage_deduction' AND createdAt >= ?
       GROUP BY bucket`,
      [session.userId, since]
    );

    const summary = { standard: 0, bonus: 0, resource: 0 };
    for (const r of rows) {
      if (r.bucket in summary) summary[r.bucket] = r.spent;
    }

    return NextResponse.json({ ...summary, period, since });
  } catch {
    return NextResponse.json({ standard: 0, bonus: 0, resource: 0, period, since });
  }
}
