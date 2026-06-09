import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { deletePlan, getPlanById, updatePlan } from "@/lib/db/repos/plansRepo";
import { validatePlanInput } from "@/lib/plans/validatePlanInput";

export const dynamic = "force-dynamic";

function errorResponse(error, status = 400) {
  return NextResponse.json({ error }, { status });
}

async function planId(params) {
  const resolved = await params;
  return resolved?.id;
}

export async function GET(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return errorResponse("Forbidden", 403);

  const plan = await getPlanById(await planId(params));
  if (!plan) return errorResponse("Plan not found", 404);
  return NextResponse.json({ plan });
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

  const parsed = validatePlanInput(body, { partial: true });
  if (!parsed.ok) return errorResponse(parsed.error, 400);

  try {
    const plan = await updatePlan(await planId(params), parsed.data);
    if (!plan) return errorResponse("Plan not found", 404);
    return NextResponse.json({ plan });
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("unique")) {
      return errorResponse("Plan name already exists", 409);
    }
    console.error("[API] Failed to update plan:", error);
    return errorResponse("Failed to update plan", 500);
  }
}

export async function DELETE(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return errorResponse("Forbidden", 403);

  try {
    const result = await deletePlan(await planId(params), { hard: false });
    if (!result.deleted) return errorResponse("Plan not found", 404);
    return NextResponse.json({ success: true, deleted: true, hard: false });
  } catch (error) {
    console.error("[API] Failed to disable plan:", error);
    return errorResponse("Failed to disable plan", 500);
  }
}
