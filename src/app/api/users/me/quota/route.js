import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getUserById } from "@/lib/db/index.js";
import { getPlanQuotaStatus } from "@/lib/quota/planQuotaStatus.js";

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

  const [quota, user] = await Promise.all([
    getPlanQuotaStatus(session.userId),
    getUserById(session.userId),
  ]);

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    source: quota.source ?? "error",
    planName: quota.planName ?? null,
    planExpiresAt: quota.planExpiresAt ?? user.planExpiresAt ?? null,
    rpm: quota.rpm ?? 0,
    rpmUsed: quota.rpmUsed ?? 0,
    quota5h: quota.quota5h ?? { limit: 0, consumed: 0, resetAt: null },
    quotaWeekly: quota.quotaWeekly ?? { limit: 0, consumed: 0, resetAt: null },
    creditsBalance: user.creditsBalance ?? 0,
    allowCreditOverflow: quota.allowCreditOverflow ?? user.allowCreditOverflow ?? false,
  });
}
