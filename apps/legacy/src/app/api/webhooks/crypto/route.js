/**
 * POST /api/webhooks/crypto — Story 2.8 Task 4 / Story 2.9 Task 5
 * NOWPayments IPN. Settlement extracted to shared settlePayment().
 */
import { NextResponse } from "next/server";
import * as nowpaymentsAdapter from "@/lib/payment/nowpayments-adapter";
import { getPaymentByGatewayId, updatePayment } from "@/lib/db/repos/paymentsRepo";
import { settlePayment } from "@/lib/payment/settle";
import { getAdapter } from "@/lib/db/driver";

export const dynamic = "force-dynamic";

const TERMINAL_STATUSES = new Set(["settled", "failed", "expired"]);

export async function POST(request) {
  let rawBody;
  try { rawBody = await request.text(); }
  catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }

  if (!nowpaymentsAdapter.verifyAuth(request, rawBody)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let parsed;
  try { parsed = nowpaymentsAdapter.parseIpn(rawBody); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { gatewayPaymentId, internalStatus, _raw: data } = parsed;
  if (!gatewayPaymentId || !internalStatus) return NextResponse.json({ ok: true });

  try {
    let payment = await getPaymentByGatewayId(gatewayPaymentId);

    if (!payment && data.order_id) {
      const { getPaymentById } = await import("@/lib/db/repos/paymentsRepo");
      payment = await getPaymentById(data.order_id);
      if (payment && !payment.gatewayPaymentId) {
        await updatePayment(payment.id, { gatewayPaymentId });
      }
    }

    if (!payment) {
      console.warn(`[webhook/crypto] Payment not found: gatewayPaymentId=${gatewayPaymentId}, order_id=${data.order_id}`);
      return NextResponse.json({ ok: true });
    }
    if (payment.status === "settled") return NextResponse.json({ ok: true });

    if (internalStatus === "settled") {
      const settlement = nowpaymentsAdapter.resolveSettlement(gatewayPaymentId, data);
      await settlePayment(payment, settlement);
      return NextResponse.json({ ok: true });
    }

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
          data.payin_hash || data.purchase_id || fresh.txHash || payment.txHash || null,
          now,
          payment.id,
        ]
      );
    });
    return NextResponse.json({ ok: true });

  } catch (err) {
    console.error("[webhook/crypto] Error processing IPN:", err.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
