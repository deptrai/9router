import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getUserByEmail, createUser } from "@/lib/db/index.js";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { checkLock, recordFail, getClientIp } from "@/lib/auth/loginLimiter";

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

    // Set auth cookie with user claims
    const cookieStore = await cookies();
    await setDashboardAuthCookie(cookieStore, request, {
      role: "user",
      userId: user.id,
      email: user.email,
    });

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
