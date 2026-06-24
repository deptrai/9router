import { NextResponse } from "next/server";
import { verifyWebhookSecret } from "@/lib/payment/vndBank.js";

export const dynamic = "force-dynamic";
import { getAdapter } from "@/lib/db/driver.js";
import { recordCreditTxn } from "@/lib/db/repos/creditLedgerRepo.js";
import { payAffiliateCommission } from "@/lib/affiliate/affiliateCommission.js";
import { notifyAdminPaymentSettled } from "@/lib/admin/notifyAdmin.js";

export async function POST(request) {
  const secret = request.headers.get("X-Sepay-Secret") || request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!verifyWebhookSecret(secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ ok: true });
  }

  const { transferType, content } = body;
  // Coerce transferAmount to Number — SePay may send string; comparison would be type-unsafe otherwise (P5)
  const transferAmount = Number(body.transferAmount);
  if (transferType !== "in" || !Number.isFinite(transferAmount) || transferAmount <= 0 || !content) {
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

  // Reject late transfers for expired payments (sweep may not have run yet)
  if (payment.expiresAt && new Date(payment.expiresAt) < new Date()) {
    return NextResponse.json({ ok: true, note: "payment_expired" });
  }

  // Credit the AGREED amount, not the transferred one — overpay does not bonus credits (P4).
  // Use canonical 'settled' status to align with settle.js TERMINAL_STATUSES + paymentExpirySweep (P3).
  const credits = Number(payment.credits);
  if (!Number.isFinite(credits) || credits <= 0) {
    return NextResponse.json({ ok: true, note: "credits_zero" });
  }
  const now = new Date().toISOString();

  // P10: UPDATE + recordCreditTxn in one synchronous transaction so a partial failure
  // does not leave a settled payment row with no ledger entry. recordCreditTxn runs
  // inline (synchronous) when passed the adapter — matches settle.js (BP-5).
  // Idempotency is guaranteed by recordCreditTxn's idempotencyKey (BP-4): a duplicate
  // webhook re-runs the UPDATE harmlessly and gets the existing ledger row back.
  let txn;
  db.transaction(() => {
    db.run(`UPDATE payments SET status = 'settled', confirmedAt = ?, settledAt = ?, rawWebhook = ? WHERE id = ?`,
      [now, now, JSON.stringify(body).slice(0, 2000), payment.id]);

    txn = recordCreditTxn({
      userId: payment.userId,
      type: "vnd_topup",
      bucket: "standard",
      amount: credits,
      refId: payment.id,
      idempotencyKey: `vnd:${payment.id}`,
      note: `Nạp ${transferAmount.toLocaleString()}đ → ${credits} credits`,
    }, db);
  });

  // Affiliate commission (best-effort)
  try {
    await payAffiliateCommission({ userId: payment.userId, txnId: txn?.id, type: "vnd_topup", amount: credits });
  } catch {}

  // Admin Telegram notification (fire-and-forget)
  notifyAdminPaymentSettled({
    type: "vnd",
    userEmail: payment.userId,
    credits,
    amount: transferAmount,
    currency: "VND",
    paymentId: payment.id,
  }).catch(() => {});

  return NextResponse.json({ ok: true, credited: credits });
}
