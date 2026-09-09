/**
 * Story 2-38.3 — Verify Telegram OTP, discover catalog, create supplier source,
 * sync products, and auto-publish all variants.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { verifyTelegramLogin } from "@/lib/store/telegramOnboard";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  try {
    const result = await verifyTelegramLogin({
      loginId: body?.loginId,
      phoneCode: body?.phoneCode,
      session: body?.session,
      botUsername: body?.botUsername,
      vndPerCredit: body?.vndPerCredit,
      relayUrl: body?.relayUrl,
      relayToken: body?.relayToken,
      markupPct: body?.markupPct,
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[api/store/suppliers/onboard/telegram/verify] lỗi:", e?.message);
    return NextResponse.json({ error: e?.message || "Không thể hoàn tất onboard" }, { status: 500 });
  }
}
