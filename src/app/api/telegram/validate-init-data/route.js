import { NextResponse } from "next/server";
import { validateInitData } from "@/lib/auth/telegramWebApp.js";

export const dynamic = "force-dynamic";

/**
 * Validate Telegram Web App initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const { initData } = body || {};
    if (!initData || typeof initData !== "string") {
      return NextResponse.json({ error: "initData missing" }, { status: 400 });
    }

    const result = validateInitData(initData);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    return NextResponse.json({ ok: true, user: result.user });
  } catch (e) {
    console.error("[api/telegram/validate-init-data] error:", e?.message);
    return NextResponse.json({ error: "validation failed" }, { status: 500 });
  }
}
