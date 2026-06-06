import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getUserById } from "@/lib/db/index.js";
import { createEmailVerifyToken } from "@/lib/auth/emailVerifyToken.js";
import { sendEmail } from "@/lib/email/sendEmail.js";
import { checkLock, recordFail, getClientIp } from "@/lib/auth/loginLimiter";

export async function POST(request) {
  try {
    // Rate-limit by IP to prevent email bombing
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${lock.retryAfter}s` },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    // Require authenticated user session
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);

    if (!session || session.role !== "user") {
      return NextResponse.json({ error: "Forbidden — user role required" }, { status: 403 });
    }

    const user = await getUserById(session.userId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Already verified → no-op
    if (user.isEmailVerified) {
      return NextResponse.json({ success: true, alreadyVerified: true });
    }

    // Create token + send email
    const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:20128";
    const token = await createEmailVerifyToken(user.id, user.email);

    await sendEmail({
      to: user.email,
      subject: "Xác minh email 9Router",
      html: `<p>Chào ${user.displayName || user.email},</p>
<p>Click vào link dưới đây để xác minh địa chỉ email của bạn:</p>
<p><a href="${baseUrl}/verify-email?token=${token}">${baseUrl}/verify-email?token=${token}</a></p>
<p>Link có hiệu lực trong 24 giờ.</p>`,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[send-verification] error:", error.message);
    return NextResponse.json(
      { error: "Failed to send verification email" },
      { status: 500 }
    );
  }
}
