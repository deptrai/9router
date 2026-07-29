/**
 * Story 2-38.3 — Start Telegram login for supplier bot onboarding.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { startTelegramLogin } from "@/lib/store/telegramOnboard";

export const dynamic = "force-dynamic";

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
    const result = await startTelegramLogin({ phone: body?.phone });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[api/store/suppliers/onboard/telegram/start] lỗi:", e?.message);
    return NextResponse.json({ error: e?.message || "Không thể gửi mã OTP" }, { status: 500 });
  }
}
