import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getUserById, getReferrals, getReferralCount } from "@/lib/db/index.js";
import { getLedgerByUser } from "@/lib/db/repos/creditLedgerRepo.js";

export async function GET(request) {
  const session = await getDashboardAuthSession(request);
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await getUserById(session.userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "";
  const referredCount = await getReferralCount(user.id);
  const referrals = await getReferrals(user.id, { limit: 20 });

  const commTxns = await getLedgerByUser(user.id, { type: "affiliate_commission", limit: 10000 });
  const storeCommTxns = await getLedgerByUser(user.id, { type: "affiliate_store_commission", limit: 10000 });
  const totalCommission = [...commTxns, ...storeCommTxns].reduce((sum, t) => sum + (t.amount || 0), 0);

  return NextResponse.json({
    refCode: user.refCode,
    referralLink: baseUrl ? `${baseUrl}/register?ref=${user.refCode}` : null,
    referredCount,
    totalCommission: Math.round(totalCommission * 100) / 100,
    referrals: referrals.map((r) => ({
      displayName: r.displayName || r.email?.split("@")[0] || null,
      createdAt: r.createdAt,
    })),
  });
}
