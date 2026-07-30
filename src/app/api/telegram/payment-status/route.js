import { NextResponse } from "next/server";
import { validateInitData } from "@/lib/auth/telegramWebApp.js";
import { getPaymentById } from "@/lib/db/repos/paymentsRepo.js";
import { getUserByTelegramId } from "@/lib/db/repos/usersRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const initData = searchParams.get("initData");
    const paymentId = searchParams.get("id");

    if (!initData || !paymentId) {
      return NextResponse.json({ error: "initData and id are required" }, { status: 400 });
    }

    const result = validateInitData(initData);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    const telegramId = String(result.user.id);
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const payment = await getPaymentById(paymentId);
    if (!payment) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (payment.userId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({
      success: true,
      payment: {
        id: payment.id,
        status: payment.status,
        amountReceived: payment.amountReceived,
        creditsAwarded: payment.creditsAwarded,
        settledAt: payment.settledAt,
        errorMessage: payment.errorMessage,
      },
    });
  } catch (e) {
    console.error("[api/telegram/payment-status] error:", e?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
