import { NextResponse } from "next/server";
import { validateInitData } from "@/lib/auth/telegramWebApp.js";
import { getUserByTelegramId } from "@/lib/db/repos/usersRepo.js";
import { getBalanceByBucket } from "@/lib/db/repos/creditLedgerRepo.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const { initData } = await request.json();
    if (!initData || typeof initData !== "string") {
      return NextResponse.json({ error: "initData missing" }, { status: 400 });
    }

    const result = validateInitData(initData);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    const telegramId = String(result.user.id);
    const user = await getUserByTelegramId(telegramId);
    const balances = user ? await getBalanceByBucket(user.id) : { standard: 0, bonus: 0, resource: 0 };

    return NextResponse.json({
      ok: true,
      user: result.user,
      queryId: result.queryId,
      balances,
      hasAccount: !!user,
    });
  } catch (e) {
    console.error("[api/telegram/user-info] error:", e?.message);
    return NextResponse.json({ error: "user-info failed" }, { status: 500 });
  }
}
