import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  isGoogleConfigured,
  getPublicOrigin,
  fetchGoogleDiscovery,
  exchangeGoogleCode,
  verifyGoogleIdToken,
} from "@/lib/auth/googleOidc.js";
import { setDashboardAuthCookie, getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import {
  getUserByGoogleSub,
  getUserByEmail,
  getUserById,
  updateUser,
  createUser,
} from "@/lib/db/repos/usersRepo.js";

export async function GET(request) {
  const origin = getPublicOrigin(request);
  if (!isGoogleConfigured()) {
    return NextResponse.redirect(`${origin}/login?error=google_not_configured`);
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");

  const cookieStore = await cookies();
  const storedState = cookieStore.get("google_state")?.value;
  const storedNonce = cookieStore.get("google_nonce")?.value;
  const isLink = cookieStore.get("google_link")?.value === "1";
  cookieStore.delete("google_state");
  cookieStore.delete("google_nonce");
  cookieStore.delete("google_link");

  if (errorParam) {
    return NextResponse.redirect(`${origin}/login?error=google_denied`);
  }
  if (!code || !state || !storedState || state !== storedState) {
    return NextResponse.redirect(`${origin}/login?error=google_state_mismatch`);
  }

  try {
    const discovery = await fetchGoogleDiscovery();
    const redirectUri = `${origin}/api/auth/google/callback`;
    const tokens = await exchangeGoogleCode({ code, redirectUri, tokenEndpoint: discovery.token_endpoint });
    const profile = await verifyGoogleIdToken(tokens.id_token, storedNonce);

    if (isLink) {
      const authToken = cookieStore.get("auth_token")?.value;
      const session = await getDashboardAuthSession(authToken);
      if (!session?.userId) {
        return NextResponse.redirect(`${origin}/login?error=not_logged_in`);
      }
      const existingOwner = await getUserByGoogleSub(profile.sub);
      if (existingOwner && existingOwner.id !== session.userId) {
        return NextResponse.redirect(`${origin}/dashboard/profile?error=google_already_linked`);
      }
      await updateUser(session.userId, { googleSub: profile.sub });
      return NextResponse.redirect(`${origin}/dashboard/profile?linked=google`);
    }

    let user = await getUserByGoogleSub(profile.sub);
    if (!user) {
      const emailUser = await getUserByEmail(profile.email);
      if (emailUser?.isEmailVerified) {
        await updateUser(emailUser.id, { googleSub: profile.sub });
        user = await getUserById(emailUser.id);
      } else {
        user = await createUser(profile.email, null, profile.name || "Google user");
        await updateUser(user.id, { googleSub: profile.sub, isEmailVerified: true });
        user = await getUserById(user.id);
      }
    }

    if (!user.isActive) {
      return NextResponse.redirect(`${origin}/login?error=account_disabled`);
    }

    await setDashboardAuthCookie(cookieStore, request, {
      userId: user.id,
      role: "user",
      email: user.email,
    });
    return NextResponse.redirect(`${origin}/dashboard`);
  } catch (e) {
    console.error("[google/callback]", e?.message || e);
    return NextResponse.redirect(`${origin}/login?error=google_failed`);
  }
}
