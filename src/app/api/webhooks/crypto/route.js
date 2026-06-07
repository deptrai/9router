/**
 * POST /api/webhooks/crypto — Story 2.8 Task 4 (AC4)
 * NOWPayments IPN callback. HMAC-SHA512 verified, idempotent, fail-soft.
 */
import { NextResponse } from "next/server";
import { verifyIpnSignature } from "@/lib/payment/nowpayments";
import { getPaymentByGatewayId, updatePayment } from "@/lib/db/repos/paymentsRepo";
import { addCredits } from "@/lib/db/repos/usersRepo";
import { getAdapter } from "@/lib/db/driver";

export const dynamic = "force-dynamic";

// NOWPayments status → internal status mapping
const STATUS_MAP = {
  waiting: "pending",
  confirming: "confirming",
  confirmed: "confirmed",
  sending: "confirmed",
  finished: "settled",
  partially_paid: "confirming",
  failed: "failed",
  expired: "expired",
  refunded: "failed",
};

const TERMINAL_STATUSES = new Set(["settled", "failed", "expired"]);

export async function POST(request) {
  // 1. Read raw body + signature header
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const signature = request.headers.get("x-nowpayments-sig");
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;

  // 2. Verify HMAC-SHA512 signature
  if (!secret || !verifyIpnSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 3. Parse body
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const gatewayPaymentId = String(data.payment_id || "");
  const npStatus = (data.payment_status || "").toLowerCase();
  const internalStatus = STATUS_MAP[npStatus];

  if (!gatewayPaymentId || !internalStatus) {
    return NextResponse.json({ ok: true }); // unknown status → ack, no action
  }

  // 4. Idempotency: lookup payment by gatewayPaymentId
  try {
    let payment = await getPaymentByGatewayId(gatewayPaymentId);

    // If no payment found, it might be a new IPN before create route stored gatewayPaymentId.
    // Try to find by gatewayInvoiceId (order_id in IPN = our internal payment.id)
    if (!payment && data.order_id) {
      const { getPaymentById } = await import("@/lib/db/repos/paymentsRepo");
      payment = await getPaymentById(data.order_id);
      // Set gatewayPaymentId on first IPN hit
      if (payment && !payment.gatewayPaymentId) {
        await updatePayment(payment.id, { gatewayPaymentId });
      }
    }

    if (!payment) {
      // Payment not found — ack to avoid NOWPayments retries on unknown payments
      console.warn(`[webhook/crypto] Payment not found: gatewayPaymentId=${gatewayPaymentId}, order_id=${data.order_id}`);
      return NextResponse.json({ ok: true });
    }

    // 5. Already settled → no-op (double-credit prevention)
    if (payment.status === "settled") {
      return NextResponse.json({ ok: true });
    }

    // 6. Status = "finished" → settle (award credits atomically)
    if (internalStatus === "settled") {
      const db = await getAdapter();
      const amountReceived = Number(data.actually_paid) || Number(data.pay_amount) || payment.amountExpected;
      const bonusMultiplier = 1 + (payment.bonusPercent || 0) / 100;
      const creditsToAward = amountReceived * bonusMultiplier;

      db.transaction(() => {
        // Recheck inside transaction (race guard)
        const fresh = db.get(`SELECT status FROM payments WHERE id = ?`, [payment.id]);
        if (fresh?.status === "settled") return; // double-check idempotency

        // Update payment → settled
        const now = new Date().toISOString();
        db.run(
          `UPDATE payments SET status=?, amountReceived=?, creditsAwarded=?, txHash=?, payAddress=?, settledAt=?, confirmations=?, updatedAt=? WHERE id=?`,
          ["settled", amountReceived, creditsToAward, data.payin_hash || data.purchase_id || null, data.pay_address || payment.payAddress || null, now, Number(data.confirmations) || 0, now, payment.id]
        );

        // Award credits to user (same transaction → atomic)
        db.run(
          `UPDATE users SET creditsBalance = creditsBalance + ?, updatedAt = ? WHERE id = ?`,
          [creditsToAward, now, payment.userId]
        );
      });

      return NextResponse.json({ ok: true });
    }

    // 7. Other status transitions → update payment record without moving terminal rows backward
    const db = await getAdapter();
    db.transaction(() => {
      const fresh = db.get(`SELECT status, txHash FROM payments WHERE id = ?`, [payment.id]);
      if (!fresh || TERMINAL_STATUSES.has(fresh.status)) return;

      const now = new Date().toISOString();
      db.run(
        `UPDATE payments SET status=?, confirmations=?, payAddress=?, amountReceived=?, txHash=?, updatedAt=? WHERE id=?`,
        [
          internalStatus,
          data.confirmations != null ? Number(data.confirmations) || 0 : payment.confirmations,
          data.pay_address || payment.payAddress || null,
          data.actually_paid ? Number(data.actually_paid) : payment.amountReceived,
          (data.payin_hash || data.purchase_id || fresh.txHash || payment.txHash || null),
          now,
          payment.id,
        ]
      );
    });
    return NextResponse.json({ ok: true });

  } catch (err) {
    // Fail-soft: log + return 500 (NOWPayments will retry)
    console.error("[webhook/crypto] Error processing IPN:", err.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
