import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getUserById } from "@/lib/db/index.js";

export async function GET() {
  try {
    const settings = await getSettings();
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    const requireLogin = settings.requireLogin !== false;
    const authMode = settings.authMode || "password";
    const oidcName = String(session?.oidcName || "").trim();
    const oidcEmail = String(session?.oidcEmail || "").trim();
    const displayName = oidcName || oidcEmail || (session?.oidc ? "OIDC user" : "Password user");
    const loginMethod = session?.oidc ? "OIDC" : "Password";

    // New fields for user accounts (Story 2.2)
    const role = session?.role ?? "admin"; // legacy tokens without role → admin
    const userId = session?.userId ?? null;
    const email = session?.email ?? null;
    let creditsBalance = null;
    let isEmailVerified = false;
    if (userId) {
      try {
        const user = await getUserById(userId);
        creditsBalance = user?.creditsBalance ?? null;
        isEmailVerified = !!user?.isEmailVerified;
      } catch {
        creditsBalance = null;
        isEmailVerified = false;
      }
    }

    return NextResponse.json({
      requireLogin,
      authMode,
      oidcConfigured: isOidcConfigured(settings),
      oidcLoginLabel: (settings.oidcLoginLabel || "Sign in with OIDC").trim() || "Sign in with OIDC",
      hasPassword: !!settings.password,
      displayName,
      loginMethod,
      oidcName: oidcName || null,
      oidcEmail: oidcEmail || null,
      oidcLogin: !!session?.oidc,
      // New fields
      role,
      userId,
      email,
      creditsBalance,
      isEmailVerified,
    });
  } catch {
    return NextResponse.json({
      requireLogin: true,
      authMode: "password",
      oidcConfigured: false,
      oidcLoginLabel: "Sign in with OIDC",
      hasPassword: false,
      displayName: "Password user",
      loginMethod: "Password",
      oidcName: null,
      oidcEmail: null,
      oidcLogin: false,
      // New fields — null in fallback
      role: "admin",
      userId: null,
      email: null,
      creditsBalance: null,
      isEmailVerified: false,
    });
  }
}
