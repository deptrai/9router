import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getUserByEmail, createUser, getUserByRefCode, updateUser } from "@/lib/db/index.js";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { checkLock, recordFail, getClientIp } from "@/lib/auth/loginLimiter";
import { createEmailVerifyToken } from "@/lib/auth/emailVerifyToken.js";
import { sendEmail } from "@/lib/email/sendEmail.js";
import { escapeHtml } from "@/lib/email/escapeHtml.js";
import { verifyTurnstile } from "@/lib/auth/turnstile.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  try {
    // Rate-limit register by IP (prevent brute-force enumeration + bcrypt DoS)
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${lock.retryAfter}s` },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }
    const body = await request.json();
    const { password, displayName } = body;
    const email = (body.email || "").trim().toLowerCase() || null;

    // Turnstile captcha — block bot account creation + bcrypt DoS (skipped when
    // TURNSTILE_SECRET_KEY is unset, e.g. local dev). Verify before any expensive work.
    const captcha = await verifyTurnstile(body.turnstileToken, ip);
    if (!captcha.ok) {
      recordFail(ip);
      return NextResponse.json(
        { error: "Captcha verification failed. Please try again." },
        { status: 400 }
      );
    }

    // Validate email
    if (!email || !EMAIL_REGEX.test(email)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 }
      );
    }

    // Validate password
    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    // Check if email already exists
    const existing = await getUserByEmail(email);
    if (existing) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409 }
      );
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, 10);
    const name = displayName || email.split("@")[0];

    let user;
    try {
      user = await createUser(email, passwordHash, name);
    } catch (err) {
      // UNIQUE constraint violation (TOCTOU race) → treat as duplicate
      if (err.message && err.message.includes("UNIQUE")) {
        return NextResponse.json(
          { error: "Email already registered" },
          { status: 409 }
        );
      }
      throw err; // re-throw other errors to outer catch
    }

    // Affiliate: link referrer if valid ref code provided
    const ref = body.ref || null;
    if (ref) {
      try {
        const referrer = await getUserByRefCode(ref);
        if (referrer && referrer.id !== user.id) {
          await updateUser(user.id, { referredBy: referrer.id });
        }
      } catch {}
    }

    // Set auth cookie with user claims
    const cookieStore = await cookies();
    await setDashboardAuthCookie(cookieStore, request, {
      role: "user",
      userId: user.id,
      email: user.email,
    });

    // Fail-soft: send verification email — errors MUST NOT block registration (AC3)
    try {
      const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:20128";
      const token = await createEmailVerifyToken(user.id, user.email);
      await sendEmail({
        to: user.email,
        subject: "Xác minh email 9Router",
        html: `<p>Chào ${escapeHtml(user.displayName || user.email)},</p>
<p>Click vào link dưới đây để xác minh địa chỉ email của bạn:</p>
<p><a href="${baseUrl}/verify-email?token=${token}">${baseUrl}/verify-email?token=${token}</a></p>
<p>Link có hiệu lực trong 24 giờ. Nếu bạn không đăng ký, hãy bỏ qua email này.</p>`,
      });
    } catch (emailErr) {
      // Intentionally swallowed — email failure NEVER blocks registration
      console.warn("[register] email send failed (non-critical):", emailErr?.message);
    }

    return NextResponse.json({
      success: true,
      userId: user.id,
      email: user.email,
    });
  } catch (error) {
    console.error("[register] error:", error.message);
    return NextResponse.json(
      { error: "Registration failed" },
      { status: 500 }
    );
  }
}
