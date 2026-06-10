import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { getUserById, updateUser } from "@/lib/db/repos/usersRepo.js";

export async function POST(request) {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session?.userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { provider } = body;
  if (!["google", "telegram"].includes(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  const user = await getUserById(session.userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const authMethodCount = [user.hasPassword, !!user.googleSub, !!user.telegramId].filter(Boolean).length;
  if (authMethodCount <= 1) {
    return NextResponse.json({ error: "Không thể xóa phương thức đăng nhập duy nhất" }, { status: 400 });
  }

  const updates = provider === "google" ? { googleSub: null } : { telegramId: null };
  await updateUser(session.userId, updates);
  return NextResponse.json({ success: true, unlinked: provider });
}
