import { getAdapter } from "@/lib/db/driver.js";

export async function runPaymentExpirySweep() {
  const adapter = await getAdapter();
  const now = new Date().toISOString();
  const result = adapter.run(
    `UPDATE payments SET status='expired', updatedAt=?
     WHERE status='pending' AND expiresAt IS NOT NULL AND expiresAt < ?`,
    [now, now],
  );
  const expired = result?.changes ?? 0;
  if (expired > 0) {
    console.log(`[paymentSweep] marked ${expired} pending payment(s) as expired`);
  }
  return { expired };
}
