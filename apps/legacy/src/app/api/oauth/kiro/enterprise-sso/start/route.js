import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";

/**
 * POST /api/oauth/kiro/enterprise-sso/start
 * Start an Enterprise SSO session.
 *
 * Without body: returns Kiro portal sign-in URL (portal-assisted flow).
 * With body {email, issuerURL, clientID, scopes}: returns Azure AD auth URL
 * directly, bypassing the Kiro portal (direct flow).
 */
export async function POST(request) {
  try {
    const kiroService = new KiroService();
    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const { email, issuerURL, clientID, scopes } = body || {};

    // Direct mode: caller provides tenant-specific OIDC params, skip portal
    if (issuerURL && clientID) {
      const { sessionId, authUrl } = await kiroService.startDirectEnterpriseSsoSession({
        email, issuerURL, clientID, scopes,
      });
      return NextResponse.json({ sessionId, authUrl, mode: "direct" });
    }

    // Portal-assisted mode (default)
    const result = kiroService.startEnterpriseSsoSession();
    return NextResponse.json({ ...result, mode: "portal" });
  } catch (error) {
    console.log("Enterprise SSO start error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
