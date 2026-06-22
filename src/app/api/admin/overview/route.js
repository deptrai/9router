import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const db = await getAdapter();

    const totalUsers = db.get("SELECT COUNT(*) as n FROM users WHERE isActive=1")?.n ?? 0;

    const activeUsers7d = db.get(`
      SELECT COUNT(DISTINCT u.id) as n FROM users u
      JOIN apiKeys k ON k.userId = u.id
      JOIN usageHistory h ON h.apiKey = k.key
      WHERE h.timestamp >= datetime('now', '-7 days')
    `)?.n ?? 0;

    const revRow = db.get(`
      SELECT
        COALESCE(SUM(creditsAwarded), 0) AS total,
        COALESCE(SUM(CASE WHEN createdAt >= datetime('now','-7 days') THEN creditsAwarded ELSE 0 END), 0) AS rev7d,
        COALESCE(SUM(CASE WHEN createdAt >= datetime('now','-30 days') THEN creditsAwarded ELSE 0 END), 0) AS rev30d,
        COALESCE(SUM(CASE WHEN provider='vnd' AND createdAt >= datetime('now','-30 days') THEN 1 ELSE 0 END), 0) AS cntVnd,
        COALESCE(SUM(CASE WHEN (provider IS NULL OR provider!='vnd') AND createdAt >= datetime('now','-30 days') THEN 1 ELSE 0 END), 0) AS cntCrypto
      FROM payments WHERE status='settled'
    `) ?? {};

    const totalCreditsInCirculation = db.get(
      "SELECT COALESCE(SUM(creditsBalance), 0) as n FROM users WHERE isActive=1"
    )?.n ?? 0;

    const pendingPaymentsCount = db.get(
      "SELECT COUNT(*) as n FROM payments WHERE status='pending'"
    )?.n ?? 0;

    const lowBalanceUsersCount = db.get(
      "SELECT COUNT(*) as n FROM users WHERE creditsBalance < 1.0 AND isActive=1"
    )?.n ?? 0;

    return NextResponse.json({
      totalUsers,
      activeUsers7d,
      totalCreditsInCirculation,
      revenueTotal: revRow.total ?? 0,
      revenue7d: revRow.rev7d ?? 0,
      revenue30d: revRow.rev30d ?? 0,
      topupCountVnd: revRow.cntVnd ?? 0,
      topupCountCrypto: revRow.cntCrypto ?? 0,
      pendingPaymentsCount,
      lowBalanceUsersCount,
    });
  } catch (error) {
    console.error("[admin/overview]", error);
    return NextResponse.json({ error: "Failed to fetch overview" }, { status: 500 });
  }
}
