import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getBalanceByBucket } from "@/lib/db/repos/creditLedgerRepo.js";
import { getAdapter } from "@/lib/db/driver.js";

async function getSessionUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  if (!token) return { error: 401 };
  const session = await getDashboardAuthSession(token);
  if (!session) return { error: 401 };
  if (session.role !== "user") return { error: 403 };
  return session;
}

export async function GET() {
  const result = await getSessionUser();
  if (result?.error === 401) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (result?.error === 403) {
    return NextResponse.json({ error: "Forbidden — user role required" }, { status: 403 });
  }
  const session = result;

  const balances = await getBalanceByBucket(session.userId);
  const adapter = await getAdapter();
  const now = new Date().toISOString();
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
}
