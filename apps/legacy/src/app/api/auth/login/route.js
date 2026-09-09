import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { resolveAdminFlag } from "@/lib/auth/adminEmail";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { getUserByEmail } from "@/lib/db/index.js";

const RESET_HINT = "Forgot password? Reset to default via 9Router CLI → Settings → Reset Password to Default.";

function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`, retryAfter: lock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    const body = await request.json();
    const settings = await getSettings();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    // Admin password login was removed — admin is now a regular user with an
    // isAdmin flag (bootstrap via process.env.ADMIN_EMAIL). Email is required.
    if (!body.email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const email = body.email.trim().toLowerCase();
    const userLockKey = `user:${ip}`;
    const userLock = checkLock(userLockKey);
    if (userLock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${userLock.retryAfter}s` },
        { status: 429, headers: { "Retry-After": String(userLock.retryAfter) } }
      );
    }

    const user = await getUserByEmail(email);
    if (!user || !user.isActive) {
      recordFail(userLockKey);
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    // Review fix (P5): social-only accounts store passwordHash="!" (not a valid bcrypt
    // hash). bcrypt.compare returns false for it, but guard explicitly to avoid relying
    // on bcrypt's behaviour with malformed hashes (defense-in-depth).
    if (!user.passwordHash || user.passwordHash === "!") {
      recordFail(userLockKey);
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    const isValid = await bcrypt.compare(body.password || "", user.passwordHash);
    if (!isValid) {
      recordFail(userLockKey);
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    recordSuccess(userLockKey);
    const isAdmin = await resolveAdminFlag(user);
    const cookieStore = await cookies();
    await setDashboardAuthCookie(cookieStore, request, {
      role: isAdmin ? "admin" : "user",
      userId: user.id,
      email: user.email,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
