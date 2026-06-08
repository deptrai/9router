import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getUserById } from "@/lib/db/repos/usersRepo";
import { recordCreditTxn } from "@/lib/db/repos/creditLedgerRepo";

export const dynamic = "force-dynamic";

// PUT /api/users/[id]/credits — admin only: topup or deduct credits
export async function PUT(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  // Validate amount (dev-guardrail: must be finite number)
  let amount;
  let note;
  try {
    const body = await request.json();
    amount = Number(body?.amount);
    note = body?.note || null;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!Number.isFinite(amount)) {
    return NextResponse.json({ error: "amount must be a finite number" }, { status: 400 });
  }

  // Verify user exists before topup
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  try {
    // BP-3: admin_topup type, refId=adminUserId, ledger is the authoritative audit trail
    await recordCreditTxn({
      userId: id,
      type: "admin_topup",
      bucket: "standard",
      amount,
      refId: session.userId ?? "admin",
      idempotencyKey: null,
      note: note || `Admin topup by ${session.userId ?? "admin"}`,
    });

    // Read updated balance
    const updated = await getUserById(id);
    const newBalance = updated?.creditsBalance ?? 0;

    return NextResponse.json({ success: true, newBalance });
  } catch (error) {
    console.error("[API] Failed to topup credits:", error);
    return NextResponse.json({ error: "Failed to update credits" }, { status: 500 });
  }
}
