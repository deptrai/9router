import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyTelegramPayload, isTelegramAuthFresh } from "@/lib/auth/telegramAuth.js";
import { setDashboardAuthCookie, getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { getUserByTelegramId, updateUser, createUser } from "@/lib/db/repos/usersRepo.js";

export async function POST(request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return NextResponse.json({ error: "Telegram login not configured" }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { link, ...telegramData } = body;

  if (!verifyTelegramPayload(telegramData, botToken)) {
    return NextResponse.json({ error: "Invalid Telegram authentication" }, { status: 401 });
  }
  if (!isTelegramAuthFresh(telegramData.auth_date)) {
    return NextResponse.json({ error: "Telegram authentication expired" }, { status: 401 });
  }

  const telegramId = String(telegramData.id);
  const cookieStore = await cookies();

  if (link) {
    const authToken = cookieStore.get("auth_token")?.value;
    const session = await getDashboardAuthSession(authToken);
    if (!session?.userId) {
      return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    }
    const existingOwner = await getUserByTelegramId(telegramId);
    if (existingOwner && existingOwner.id !== session.userId) {
      return NextResponse.json({ error: "Tài khoản Telegram đã liên kết với user khác" }, { status: 409 });
    }
    await updateUser(session.userId, { telegramId });
    return NextResponse.json({ success: true, linked: "telegram" });
  }

  let user = await getUserByTelegramId(telegramId);
  if (!user) {
    const placeholderEmail = `telegram_${telegramId}@placeholder.local`;
    const displayName = [telegramData.first_name, telegramData.last_name].filter(Boolean).join(" ") || `tg_${telegramId}`;
    user = await createUser(placeholderEmail, null, displayName);
    await updateUser(user.id, { telegramId });
    user = await getUserByTelegramId(telegramId);
  }

  if (!user.isActive) {
    return NextResponse.json({ error: "Account disabled" }, { status: 403 });
  }

  await setDashboardAuthCookie(cookieStore, request, {
    userId: user.id,
    role: "user",
    email: user.email,
  });
  return NextResponse.json({ success: true });
}
