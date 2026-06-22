import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

const VALID_PERIODS = { "7d": -7, "30d": -30, "all": null };

export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const db = await getAdapter();
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "30d";
    const days = VALID_PERIODS[period];
    if (days === undefined) return NextResponse.json({ error: "Invalid period" }, { status: 400 });

    const dateFilter = days !== null ? `AND createdAt >= datetime('now', '${days} days')` : "";

    const byProviderRows = db.all(`
      SELECT
        COALESCE(provider, 'crypto') as provider,
        COUNT(*) as cnt,
        COALESCE(SUM(creditsAwarded), 0) as totalCredits
      FROM payments
      WHERE status='settled' ${dateFilter}
      GROUP BY provider
    `);

    const byStatusRows = db.all(`
      SELECT status, COUNT(*) as cnt
      FROM payments
      ${days !== null ? `WHERE createdAt >= datetime('now', '${days} days')` : ""}
      GROUP BY status
    `);

    const dailyRows = db.all(`
      SELECT
        date(createdAt) as date,
        COALESCE(SUM(creditsAwarded), 0) as credits,
        COUNT(*) as cnt
      FROM payments
      WHERE status='settled' ${dateFilter}
      GROUP BY date(createdAt)
      ORDER BY date ASC
    `);

    const byProvider = {};
    for (const r of byProviderRows) {
      byProvider[r.provider] = { count: r.cnt, totalCredits: r.totalCredits };
    }

    const byStatus = {};
    for (const r of byStatusRows) {
      byStatus[r.status] = r.cnt;
    }

    return NextResponse.json({ byProvider, byStatus, daily: dailyRows });
  } catch (error) {
    console.error("[admin/payments/summary]", error);
    return NextResponse.json({ error: "Failed to fetch payments summary" }, { status: 500 });
  }
}
