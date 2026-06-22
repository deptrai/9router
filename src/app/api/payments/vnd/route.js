import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { isConfigured, generateMemo, creditsToVnd, generateVietQRUrl, getBankInfo, getPaymentTimeoutMs } from "@/lib/payment/vndBank.js";
import { getAdapter } from "@/lib/db/driver.js";

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
    if (!credits || credits < 1 || !Number.isFinite(credits)) {
      return NextResponse.json({ error: "credits must be a positive number" }, { status: 400 });
    }

    const amountVnd = creditsToVnd(credits);
    const memo = generateMemo();
    const id = uuidv4();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + getPaymentTimeoutMs()).toISOString();

    const db = await getAdapter();
    db.run(
      `INSERT INTO payments (id, userId, method, status, credits, amountVnd, memo, expiresAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, session.userId, "vnd_bank", "pending", credits, amountVnd, memo, expiresAt, now, now]
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
    return NextResponse.json({ error: err.message, stack: err.stack?.split("\n").slice(0, 5) }, { status: 500 });
  }
}
