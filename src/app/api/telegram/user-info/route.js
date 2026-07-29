import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getUserByTelegramId } from "@/lib/db/repos/usersRepo.js";
import { getBalanceByBucket } from "@/lib/db/repos/creditLedgerRepo.js";

export const dynamic = "force-dynamic";

function validateInitData(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return { error: "Bot token not configured" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { error: "hash missing" };

  const authDate = Number(params.get("auth_date") || "0");
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 86400) {
    return { error: "initData expired" };
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
    return { error: "invalid hash" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { error: "user missing" };
  try {
    return { user: JSON.parse(userRaw) };
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
