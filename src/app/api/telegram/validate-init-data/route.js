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

    // Parse raw query-string pairs without URL-decoding values.
    // Telegram's hash is computed over the raw key=value pairs as they appear in initData.
    const rawPairs = [];
    for (const part of initData.split("&")) {
      const eq = part.indexOf("=");
      const key = eq >= 0 ? part.slice(0, eq) : part;
      const value = eq >= 0 ? part.slice(eq + 1) : "";
      rawPairs.push([key, value]);
    }

    const hashPair = rawPairs.find(([k]) => k === "hash");
    const hash = hashPair ? hashPair[1] : "";
    if (!hash) {
      return NextResponse.json({ error: "hash missing" }, { status: 400 });
    }

    const authDatePair = rawPairs.find(([k]) => k === "auth_date");
    const authDate = Number(authDatePair?.[1] || "0");
    const now = Math.floor(Date.now() / 1000);
    if (!authDate || now - authDate > 86400) {
      return NextResponse.json({ error: "initData expired" }, { status: 401 });
    }

    const dataCheckPairs = rawPairs
      .filter(([k]) => k !== "hash")
      .sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = dataCheckPairs.map(([k, v]) => `${k}=${v}`).join("\n");

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

    const userPair = rawPairs.find(([k]) => k === "user");
    let user = null;
    if (userPair?.[1]) {
      try {
        user = JSON.parse(decodeURIComponent(userPair[1]));
      } catch {}
    }

    return NextResponse.json({ ok: true, user });
  } catch (e) {
    console.error("[api/telegram/validate-init-data] error:", e?.message);
    return NextResponse.json({ error: "validation failed" }, { status: 500 });
  }
}
