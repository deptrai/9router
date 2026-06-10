import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getAdapter } from "@/lib/db/driver.js";

async function getSessionUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session || session.role !== "user") return null;
  return session;
}

export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Forbidden — user role required" }, { status: 403 });
  }

  try {
    const adapter = await getAdapter();
    const now = new Date().toISOString();

    const rows = adapter.all(
      `SELECT bucket, COALESCE(SUM(amount), 0) as balance
       FROM creditTransactions
       WHERE userId = ? AND (expiresAt IS NULL OR expiresAt > ?)
       GROUP BY bucket`,
      [session.userId, now]
    );

    const balances = { standard: 0, bonus: 0, resource: 0 };
    for (const r of rows) {
      if (r.bucket in balances) balances[r.bucket] = r.balance;
    }

    const bonusExpiryRow = adapter.get(
      `SELECT MIN(expiresAt) as nextExpiry FROM creditTransactions
       WHERE userId = ? AND bucket = 'bonus' AND amount > 0 AND expiresAt > ?`,
      [session.userId, now]
    );
    const standardExpiryRow = adapter.get(
      `SELECT MIN(expiresAt) as nextExpiry FROM creditTransactions
       WHERE userId = ? AND bucket = 'standard' AND amount > 0 AND expiresAt > ?`,
      [session.userId, now]
    );

    return NextResponse.json({
      ...balances,
      total: balances.standard + balances.bonus + balances.resource,
      bonusExpiresAt: bonusExpiryRow?.nextExpiry ?? null,
      standardExpiresAt: standardExpiryRow?.nextExpiry ?? null,
    });
  } catch {
    return NextResponse.json({ standard: 0, bonus: 0, resource: 0, total: 0, bonusExpiresAt: null, standardExpiresAt: null });
  }
}
