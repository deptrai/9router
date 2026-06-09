import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getPlanById } from "@/lib/db/repos/plansRepo";
import { getUserById, updateUser } from "@/lib/db/repos/usersRepo";
import { validatePlanExpiry } from "@/lib/plans/validatePlanInput";

export const dynamic = "force-dynamic";

function errorResponse(error, status = 400) {
  return NextResponse.json({ error }, { status });
}

async function userId(params) {
  const resolved = await params;
  return resolved?.id;
}

function withPlanSummary(user, plan) {
  return {
    ...user,
    plan: plan ? { id: plan.id, name: plan.name, displayName: plan.displayName } : null,
  };
}

export async function PATCH(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return errorResponse("Forbidden", 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid request body", 400);
  }

  const id = await userId(params);
  const user = await getUserById(id);
  if (!user) return errorResponse("User not found", 404);

  const expiry = validatePlanExpiry(body?.planExpiresAt);
  if (!expiry.ok) return errorResponse(expiry.error, 400);

  if (body?.planId === null) {
    const updated = await updateUser(id, { planId: null, planExpiresAt: null });
    return NextResponse.json({ user: withPlanSummary(updated, null) });
  }

  if (typeof body?.planId !== "string" || !body.planId.trim()) {
    return errorResponse("planId must be a plan id or null", 400);
  }

  const plan = await getPlanById(body.planId);
  if (!plan || !plan.isActive) return errorResponse("Plan not found or inactive", 400);

  const updated = await updateUser(id, { planId: plan.id, planExpiresAt: expiry.value });
  return NextResponse.json({ user: withPlanSummary(updated, plan) });
}
