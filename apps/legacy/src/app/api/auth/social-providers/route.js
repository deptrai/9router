import { NextResponse } from "next/server";
import { isGoogleConfigured } from "@/lib/auth/googleOidc.js";

export async function GET() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramBotId = botToken ? botToken.split(":")[0] : null;
  return NextResponse.json({
    googleEnabled: isGoogleConfigured(),
    telegramBotUsername: process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || null,
    telegramBotId: telegramBotId || null,
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
  });
}
