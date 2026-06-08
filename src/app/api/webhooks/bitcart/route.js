/**
 * POST /api/webhooks/bitcart — Story 2.9 Task 5 (AC3)
 * Bitcart IPN: unsigned {id,status}, auth via shared-secret token in query string.
 */
import { NextResponse } from "next/server";
import * as bitcart from "@/lib/payment/bitcart";
import { getPaymentByGatewayId } from "@/lib/db/repos/paymentsRepo";
import { settlePayment } from "@/lib/payment/settle";
import { getAdapter } from "@/lib/db/driver";

export const dynamic = "force-dynamic";

const TERMINAL_STATUSES = new Set(["settled", "failed", "expired"]);

export async function POST(request) {
  let rawBody;
  try { rawBody = await request.text(); }
  catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }

  if (!bitcart.verifyAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsed;
  try { parsed = bitcart.parseIpn(rawBody); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { gatewayPaymentId, internalStatus } = parsed;
  if (!gatewayPaymentId || !internalStatus) return NextResponse.json({ ok: true });

  try {
    const payment = await getPaymentByGatewayId(gatewayPaymentId);
    if (!payment) {
      console.warn(`[webhook/bitcart] Payment not found: ${gatewayPaymentId}`);
      return NextResponse.json({ ok: true });
    }
    if (payment.status === "settled") return NextResponse.json({ ok: true });

    if (internalStatus === "settled") {
      let settlement;
      try { settlement = await bitcart.resolveSettlement(gatewayPaymentId); }
      catch (err) {
        console.error("[webhook/bitcart] resolveSettlement failed:", err.message);
        return NextResponse.json({ error: "Provider fetch failed" }, { status: 500 });
      }
      await settlePayment(payment, settlement);
      return NextResponse.json({ ok: true });
    }

    // Non-terminal transition: guard against concurrent IPNs downgrading a terminal
    // status by re-reading inside a transaction (mirrors webhooks/crypto).
    const db = await getAdapter();
    db.transaction(() => {
      const fresh = db.get(`SELECT status FROM payments WHERE id = ?`, [payment.id]);
      if (!fresh || TERMINAL_STATUSES.has(fresh.status)) return;
      const now = new Date().toISOString();
      db.run(`UPDATE payments SET status=?, updatedAt=? WHERE id=?`, [internalStatus, now, payment.id]);
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[webhook/bitcart] Error:", err.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
