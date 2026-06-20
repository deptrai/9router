import { NextResponse } from "next/server";
import { verifyWebhookSecret, vndToCredits } from "@/lib/payment/vndBank.js";
import { getAdapter } from "@/lib/db/driver.js";
import { recordCreditTxn } from "@/lib/db/repos/creditLedgerRepo.js";
import { payAffiliateCommission } from "@/lib/affiliate/affiliateCommission.js";

export async function POST(request) {
  const secret = request.headers.get("X-Sepay-Secret") || request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!verifyWebhookSecret(secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ ok: true });
  }

  const { transferType, transferAmount, content } = body;
  if (transferType !== "in" || !transferAmount || !content) {
    return NextResponse.json({ ok: true });
  }

  const memoMatch = content.match(/9R([A-F0-9]{8})/i);
  if (!memoMatch) {
    return NextResponse.json({ ok: true });
  }
  const memo = "9R" + memoMatch[1].toUpperCase();

  const db = await getAdapter();
  const payment = db.get(
    `SELECT * FROM payments WHERE memo = ? AND method = 'vnd_bank' AND status = 'pending'`,
    [memo]
  );

  if (!payment) {
    return NextResponse.json({ ok: true });
  }

  if (transferAmount < payment.amountVnd) {
    return NextResponse.json({ ok: true, note: "amount_mismatch" });
  }

  // Settle: confirm payment + credit user
  const now = new Date().toISOString();
  db.run(`UPDATE payments SET status = 'confirmed', confirmedAt = ?, rawWebhook = ? WHERE id = ?`,
    [now, JSON.stringify(body).slice(0, 2000), payment.id]);

  const credits = vndToCredits(transferAmount);
  const txn = await recordCreditTxn({
    userId: payment.userId,
    type: "vnd_topup",
    bucket: "standard",
    amount: credits,
    refId: payment.id,
    idempotencyKey: `vnd:${payment.id}`,
    note: `Nạp ${transferAmount.toLocaleString()}đ → ${credits} credits`,
  });

  // Affiliate commission
  try {
    await payAffiliateCommission({ userId: payment.userId, txnId: txn.id, type: "vnd_topup", amount: credits });
  } catch {}

  return NextResponse.json({ ok: true, credited: credits });
}
