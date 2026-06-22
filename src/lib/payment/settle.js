/**
 * settlePayment — shared settlement logic for all payment providers (Story 2.9 AC1)
 * Extracted from webhooks/crypto. Both webhook routes call this.
 */
import { getAdapter } from "@/lib/db/driver";
import { recordCreditTxn } from "@/lib/db/repos/creditLedgerRepo";
import { notifyAdminPaymentSettled } from "@/lib/admin/notifyAdmin.js";

const TERMINAL_STATUSES = new Set(["settled", "failed", "expired"]);

export async function settlePayment(payment, { amountReceived, txHash, confirmations }, db) {
  const adapter = db || (await getAdapter());
  const bonusPct = payment.bonusPercent || 0;
  const standardAmount = amountReceived;
  const bonusAmount = amountReceived * bonusPct / 100;
  const creditsToAward = standardAmount + bonusAmount;

  adapter.transaction(() => {
    const fresh = adapter.get(`SELECT status FROM payments WHERE id = ?`, [payment.id]);
    if (!fresh) return;
    if (fresh.status === "settled") return;
    if (TERMINAL_STATUSES.has(fresh.status) && fresh.status !== "settled") return;

    const now = new Date().toISOString();
    adapter.run(
      `UPDATE payments SET status=?, amountReceived=?, creditsAwarded=?, txHash=?, settledAt=?, confirmations=?, updatedAt=? WHERE id=?`,
      ["settled", amountReceived, creditsToAward, txHash || null, now, confirmations ?? 0, now, payment.id]
    );

    // BP-3: standard credit row (idempotent by payment id)
    recordCreditTxn({
      userId: payment.userId,
      type: "user_payment",
      bucket: "standard",
      amount: standardAmount,
      refId: payment.id,
      idempotencyKey: `payment:${payment.id}:standard`,
      note: `Payment settled (network: ${payment.network}, coin: ${payment.coin})`,
    }, adapter);

    // BP-7: bonus row with expiry (14 days) if bonus > 0
    if (bonusAmount > 0) {
      const bonusExpiry = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      recordCreditTxn({
        userId: payment.userId,
        type: "user_payment",
        bucket: "bonus",
        amount: bonusAmount,
        multiplier: 1 + bonusPct / 100,
        expiresAt: bonusExpiry,
        refId: payment.id,
        idempotencyKey: `payment:${payment.id}:bonus`,
        note: `Bonus ${bonusPct}% on payment (expires ${bonusExpiry})`,
      }, adapter);
    }
  });

  // Admin Telegram notification (fire-and-forget)
  notifyAdminPaymentSettled({
    type: "crypto",
    userEmail: payment.userId,
    credits: creditsToAward,
    amount: amountReceived,
    currency: `${payment.coin || "CRYPTO"}/${payment.network || ""}`,
    paymentId: payment.id,
  }).catch(() => {});
}
