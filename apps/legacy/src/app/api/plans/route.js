import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { createPlan, listPlans, countUsersByPlan } from "@/lib/db/repos/plansRepo";
import { validatePlanInput } from "@/lib/plans/validatePlanInput";

export const dynamic = "force-dynamic";

function errorResponse(error, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) return errorResponse("Forbidden", 403);

  try {
    const [plans, counts] = await Promise.all([listPlans({ activeOnly: false }), countUsersByPlan()]);
    return NextResponse.json({ plans: plans.map((plan) => ({ ...plan, userCount: counts[plan.id] ?? 0 })) });
  } catch (error) {
    console.error("[API] Failed to list plans:", error);
    return errorResponse("Failed to fetch plans", 500);
  }
}

export async function POST(request) {
  const session = await requireAdmin(request);
  if (!session) return errorResponse("Forbidden", 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid request body", 400);
  }

  const parsed = validatePlanInput(body);
  if (!parsed.ok) return errorResponse(parsed.error, 400);

  try {
    const plan = await createPlan(parsed.data);
    return NextResponse.json({ plan }, { status: 201 });
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("unique")) {
      return errorResponse("Plan name already exists", 409);
    }
    console.error("[API] Failed to create plan:", error);
    return errorResponse("Failed to create plan", 500);
  }
}
