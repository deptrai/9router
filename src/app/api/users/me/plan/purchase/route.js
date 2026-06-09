import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { PlanPurchaseError, purchasePlanForUser } from "@/lib/plans/planPurchase.js";

async function getSessionUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session || session.role !== "user") return null;
  return session;
}

function errorResponse(error, status, extra = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

export async function POST(request) {
  const session = await getSessionUser();
  if (!session) return errorResponse("Forbidden — user role required", 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid request body", 400);
  }

  const planId = typeof body?.planId === "string" ? body.planId.trim() : "";
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!planId) return errorResponse("planId is required", 400);
  if (!idempotencyKey || idempotencyKey.length > 128) return errorResponse("idempotencyKey is required", 400);

  try {
    const result = await purchasePlanForUser({ userId: session.userId, planId, idempotencyKey });
    return NextResponse.json({
      action: result.action,
      plan: result.plan,
      user: {
        id: result.user.id,
        creditsBalance: result.user.creditsBalance,
        planId: result.user.planId,
        planExpiresAt: result.user.planExpiresAt,
      },
      transaction: result.transaction,
      idempotent: result.idempotent,
    });
  } catch (error) {
    if (error instanceof PlanPurchaseError) {
      if (error.code === "PLAN_NOT_FOUND") return errorResponse("Plan not found", 404);
      if (error.code === "INSUFFICIENT_CREDITS") {
        return errorResponse("Insufficient credits", 402, {
          requiredCredits: error.requiredCredits,
          creditsBalance: error.creditsBalance,
          topupHref: error.topupHref || "/dashboard/credits",
        });
      }
      if (error.code === "INVALID_IDEMPOTENCY_KEY" || error.code === "INVALID_USER" || error.code === "INVALID_NOW") {
        return errorResponse(error.message || "Invalid request", 400);
      }
    }
    console.error("[users/me/plan/purchase] error:", error);
    return errorResponse("Failed to purchase plan", 500);
  }
}
