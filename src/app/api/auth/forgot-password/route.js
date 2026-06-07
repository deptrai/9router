import { NextResponse } from "next/server";
import { getUserByEmail } from "@/lib/db/index.js";
import { createPasswordResetToken } from "@/lib/auth/passwordResetToken.js";
import { sendEmail } from "@/lib/email/sendEmail.js";
import { checkLock, recordFail, getClientIp } from "@/lib/auth/loginLimiter";

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${lock.retryAfter}s` },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    const body = await request.json();
    const email = (body.email || "").trim().toLowerCase();

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    // Always return success (anti-enumeration: don't reveal if email exists)
    const user = await getUserByEmail(email);

    if (user && user.isActive) {
      try {
        const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:20128";
        const token = await createPasswordResetToken(user.id, user.email);
        await sendEmail({
          to: user.email,
          subject: "Đặt lại mật khẩu 9Router",
          html: `<p>Chào ${user.displayName || user.email},</p>
<p>Bạn đã yêu cầu đặt lại mật khẩu. Click vào link bên dưới:</p>
<p><a href="${baseUrl}/reset-password?token=${token}">${baseUrl}/reset-password?token=${token}</a></p>
<p>Link có hiệu lực trong 1 giờ. Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>`,
        });
      } catch {
        // Fail-soft: don't reveal error to user
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[forgot-password] error:", error.message);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
}
