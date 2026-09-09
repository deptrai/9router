import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { isConfigured, getBankInfo, createVndPayment } from "@/lib/payment/vndBank.js";

export const dynamic = "force-dynamic";

// Upper bound on a single VND topup request (P6) — guards against float/overflow/abuse.
const MAX_VND_CREDITS = 1_000_000;

/**
 * GET /api/payments/vnd — VND topup config (rate + availability) for the topup form.
 * Lets the client render the conversion rate from VND_PER_CREDIT instead of hardcoding it (P8/AC8).
 */
export async function GET() {
  return NextResponse.json({
    configured: isConfigured(),
    vndPerCredit: getBankInfo().vndPerCredit,
  });
}

export async function POST(request) {
  try {
    const token = request.cookies.get("auth_token")?.value;
    const session = await getDashboardAuthSession(token);
    if (!session?.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isConfigured()) {
      return NextResponse.json({ error: "VND payment not configured" }, { status: 503 });
    }

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const credits = Number(body.credits);
    if (!Number.isInteger(credits) || credits < 1 || credits > MAX_VND_CREDITS) {
      return NextResponse.json({ error: `credits must be an integer between 1 and ${MAX_VND_CREDITS}` }, { status: 400 });
    }

    const payment = await createVndPayment({ userId: session.userId, credits });
    const { vndPerCredit: _, ...clientBankInfo } = payment.bankInfo;

    return NextResponse.json({
      paymentId: payment.id,
      qrUrl: payment.qrUrl,
      bankInfo: clientBankInfo,
      memo: payment.memo,
      credits: payment.credits,
      amountVnd: payment.amountVnd,
      expiresAt: payment.expiresAt,
    });
  } catch (err) {
    console.error("[VND payment]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
