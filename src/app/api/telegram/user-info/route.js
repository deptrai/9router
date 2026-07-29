import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getUserByTelegramId } from "@/lib/db/repos/usersRepo.js";
import { getBalanceByBucket } from "@/lib/db/repos/creditLedgerRepo.js";

export const dynamic = "force-dynamic";

function validateInitData(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return { error: "Bot token not configured" };

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
  if (!hash) return { error: "hash missing" };

  const authDatePair = rawPairs.find(([k]) => k === "auth_date");
  const authDate = Number(authDatePair?.[1] || "0");
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 86400) {
    return { error: "initData expired" };
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
    return { error: "invalid hash" };
  }

  const userPair = rawPairs.find(([k]) => k === "user");
  if (!userPair?.[1]) return { error: "user missing" };
  try {
    return { user: JSON.parse(decodeURIComponent(userPair[1])) };
  } catch {
    return { error: "user invalid" };
  }
}

export async function POST(request) {
  try {
    const { initData } = await request.json();
    if (!initData || typeof initData !== "string") {
      return NextResponse.json({ error: "initData missing" }, { status: 400 });
    }

    const validation = validateInitData(initData);
    if (validation.error) {
      return NextResponse.json({ error: validation.error }, { status: 401 });
    }

    const telegramId = String(validation.user.id);
    const user = await getUserByTelegramId(telegramId);
    const balances = user ? await getBalanceByBucket(user.id) : { standard: 0, bonus: 0, resource: 0 };

    return NextResponse.json({
      ok: true,
      user: validation.user,
      balances,
      hasAccount: !!user,
    });
  } catch (e) {
    console.error("[api/telegram/user-info] error:", e?.message);
    return NextResponse.json({ error: "user-info failed" }, { status: 500 });
  }
}
