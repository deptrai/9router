import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  isGoogleConfigured,
  getPublicOrigin,
  createGoogleState,
  createGoogleNonce,
  buildGoogleAuthUrl,
  fetchGoogleDiscovery,
} from "@/lib/auth/googleOidc.js";

export async function GET(request) {
  if (!isGoogleConfigured()) {
    return NextResponse.json({ error: "Google login not configured" }, { status: 503 });
  }

  const cookieStore = await cookies();
  const state = createGoogleState();
  const nonce = createGoogleNonce();

  cookieStore.set("google_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
  });

  cookieStore.set("google_nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
  });

  cookieStore.set("google_link", request.nextUrl.searchParams.get("link") === "true" ? "1" : "0", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
  });

  try {
    const discovery = await fetchGoogleDiscovery();
    const redirectUri = `${getPublicOrigin(request)}/api/auth/google/callback`;
    const authUrl = buildGoogleAuthUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      redirectUri,
      state,
      nonce,
    });
    return NextResponse.redirect(authUrl);
  } catch (e) {
    return NextResponse.json({ error: "Failed to load Google OIDC config" }, { status: 500 });
  }
}
