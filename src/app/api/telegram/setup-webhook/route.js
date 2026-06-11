/**
 * POST /api/telegram/setup-webhook — đăng ký webhook URL với Telegram (Story 2.25, B4)
 *
 * Admin-only (dashboardGuard bảo vệ /api/telegram/setup-webhook vì không có trong PUBLIC_API_PATHS).
 * Gọi 1 lần sau khi deploy để kích hoạt webhook.
 */
import { NextResponse } from "next/server";
import { setWebhook } from "@/lib/telegram/botClient.js";

export async function POST() {
  const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
  if (!baseUrl) {
    return NextResponse.json(
      { error: "BASE_URL hoặc NEXT_PUBLIC_BASE_URL chưa được cấu hình" },
      { status: 500 }
    );
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "TELEGRAM_WEBHOOK_SECRET chưa được cấu hình" },
      { status: 500 }
    );
  }

  const webhookUrl = `${baseUrl.replace(/\/$/, "")}/api/telegram/webhook`;
  const result = await setWebhook(webhookUrl, secret);

  if (!result.ok) {
    return NextResponse.json(
      { error: "setWebhook thất bại", details: result },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, webhookUrl });
}
