import { NextResponse } from "next/server";
import { listPlans } from "@/lib/db/repos/plansRepo";

export const dynamic = "force-dynamic";

// GET /api/public/plans — no auth required; returns active plans for landing page pricing section.
// Only safe public fields are exposed (no admin-only metadata).
export async function GET() {
  try {
    const plans = await listPlans({ activeOnly: true });
    const safe = plans.map(({ id, name, displayName, rpm, quota5h, quotaWeekly, priceCredits, durationDays, sortOrder }) => ({
      id, name, displayName, rpm, quota5h, quotaWeekly, priceCredits, durationDays, sortOrder,
    }));
    return NextResponse.json({ plans: safe }, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (err) {
    console.error("[API] /api/public/plans error:", err);
    return NextResponse.json({ error: "Failed to load plans" }, { status: 500 });
  }
}
