import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getUserById } from "@/lib/db/repos/usersRepo.js";
import { listPlans } from "@/lib/db/repos/plansRepo.js";

async function getSessionUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session || session.role !== "user") return null;
  return session;
}

function isActiveCurrentPlan(user, now = Date.now()) {
  if (!user?.planId) return false;
  if (!user.planExpiresAt) return true;
  const expires = Date.parse(user.planExpiresAt);
  return Number.isFinite(expires) && expires > now;
}

function inferAction(user, plan, now = Date.now()) {
  const active = isActiveCurrentPlan(user, now);
  if (!active) return "buy";
  return user.planId === plan.id ? "renew" : "change";
}

export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Forbidden — user role required" }, { status: 403 });
  }

  const [user, plans] = await Promise.all([
    getUserById(session.userId),
    listPlans({ activeOnly: true }),
  ]);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const creditsBalance = user.creditsBalance ?? 0;
  return NextResponse.json({
    currentPlan: {
      planId: user.planId ?? null,
      planExpiresAt: user.planExpiresAt ?? null,
      active: isActiveCurrentPlan(user),
    },
    creditsBalance,
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      displayName: plan.displayName,
      rpm: plan.rpm,
      quota5h: plan.quota5h,
      quotaWeekly: plan.quotaWeekly,
      perModelLimits: plan.perModelLimits,
      priceCredits: plan.priceCredits ?? 0,
      durationDays: plan.durationDays ?? 30,
      canAfford: creditsBalance >= (plan.priceCredits ?? 0),
      action: inferAction(user, plan),
    })),
  });
}
