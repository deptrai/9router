import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { isConfigured, generateMemo, creditsToVnd, generateVietQRUrl, getBankInfo, getPaymentTimeoutMs } from "@/lib/payment/vndBank.js";
import { getAdapter } from "@/lib/db/driver.js";

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
    // P6: must be a positive integer with an upper bound (reject float / overflow / abuse).
    if (!Number.isInteger(credits) || credits < 1 || credits > MAX_VND_CREDITS) {
      return NextResponse.json({ error: `credits must be an integer between 1 and ${MAX_VND_CREDITS}` }, { status: 400 });
    }

    const amountVnd = creditsToVnd(credits);
    const memo = generateMemo();
    const id = uuidv4();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + getPaymentTimeoutMs()).toISOString();

    const db = await getAdapter();
    db.run(
      `INSERT INTO payments (id, userId, network, coin, amountExpected, method, status, credits, amountVnd, memo, expiresAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, session.userId, "vnd", "VND", 0, "vnd_bank", "pending", credits, amountVnd, memo, expiresAt, now, now]
    );

    const bankInfo = getBankInfo();
    const qrUrl = generateVietQRUrl({ amount: amountVnd, memo });

    return NextResponse.json({
      paymentId: id,
      qrUrl,
      bankInfo,
      memo,
      credits,
      amountVnd,
      expiresAt,
    });
  } catch (err) {
    console.error("[VND payment]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
