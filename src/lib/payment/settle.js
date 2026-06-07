/**
 * settlePayment — shared settlement logic for all payment providers (Story 2.9 AC1)
 * Extracted from webhooks/crypto. Both webhook routes call this.
 */
import { getAdapter } from "@/lib/db/driver";

const TERMINAL_STATUSES = new Set(["settled", "failed", "expired"]);

export async function settlePayment(payment, { amountReceived, txHash, confirmations }, db) {
  const adapter = db || (await getAdapter());
  const creditsToAward = amountReceived * (1 + (payment.bonusPercent || 0) / 100);

  adapter.transaction(() => {
    const fresh = adapter.get(`SELECT status FROM payments WHERE id = ?`, [payment.id]);
    if (fresh?.status === "settled") return;
    if (fresh && TERMINAL_STATUSES.has(fresh.status) && fresh.status !== "settled") return;

    const now = new Date().toISOString();
    adapter.run(
      `UPDATE payments SET status=?, amountReceived=?, creditsAwarded=?, txHash=?, settledAt=?, confirmations=?, updatedAt=? WHERE id=?`,
      ["settled", amountReceived, creditsToAward, txHash || null, now, confirmations ?? 0, now, payment.id]
    );
    adapter.run(
      `UPDATE users SET creditsBalance = creditsBalance + ?, updatedAt = ? WHERE id = ?`,
      [creditsToAward, now, payment.userId]
    );
  });
}
