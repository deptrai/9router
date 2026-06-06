import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getUserById, addCredits } from "@/lib/db/repos/usersRepo";
import { makeKv } from "@/lib/db/helpers/kvStore";

export const dynamic = "force-dynamic";

const creditTopupKv = makeKv("creditTopup");

// PUT /api/users/[id]/credits — admin only: topup or deduct credits
export async function PUT(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  // Validate amount (dev-guardrail: must be finite number)
  let amount;
  try {
    const body = await request.json();
    amount = Number(body?.amount);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!Number.isFinite(amount)) {
    return NextResponse.json({ error: "amount must be a finite number" }, { status: 400 });
  }

  // Verify user exists before topup (dev-guardrail: addCredits is void + no 404)
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  try {
    await addCredits(id, amount);

    // Read updated balance
    const updated = await getUserById(id);
    const newBalance = updated?.creditsBalance ?? 0;

    // Audit log
    try {
      await creditTopupKv.set(
        Date.now().toString(),
        JSON.stringify({
          adminId: session.userId ?? "admin",
          userId: id,
          amount,
          ts: new Date().toISOString(),
        })
      );
    } catch {
      // Audit failure is non-fatal — do not block topup
    }

    return NextResponse.json({ success: true, newBalance });
  } catch (error) {
    console.error("[API] Failed to topup credits:", error);
    return NextResponse.json({ error: "Failed to update credits" }, { status: 500 });
  }
}
