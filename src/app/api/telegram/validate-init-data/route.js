import { NextResponse } from "next/server";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * Validate Telegram Web App initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export async function POST(request) {
  try {
    const { initData } = await request.json();
    if (!initData || typeof initData !== "string") {
      return NextResponse.json({ error: "initData missing" }, { status: 400 });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return NextResponse.json({ error: "Bot token not configured" }, { status: 500 });
    }

    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) {
      return NextResponse.json({ error: "hash missing" }, { status: 400 });
    }

    const authDate = Number(params.get("auth_date") || "0");
    const now = Math.floor(Date.now() / 1000);
    if (!authDate || now - authDate > 86400) {
      return NextResponse.json({ error: "initData expired" }, { status: 401 });
    }

    params.delete("hash");
    const pairs = [];
    for (const [key, value] of params.entries()) {
      pairs.push(`${key}=${value}`);
    }
    pairs.sort();
    const dataCheckString = pairs.join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash !== hash) {
      return NextResponse.json({ error: "invalid hash" }, { status: 401 });
    }

    const userRaw = params.get("user");
    let user = null;
    if (userRaw) {
      try {
        user = JSON.parse(userRaw);
      } catch {}
    }

    return NextResponse.json({ ok: true, user });
  } catch (e) {
    console.error("[api/telegram/validate-init-data] error:", e?.message);
    return NextResponse.json({ error: "validation failed" }, { status: 500 });
  }
}
