import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";

/**
 * POST /api/oauth/kiro/enterprise-sso/resolve
 * Resolve a callback URL from the enterprise SSO flow.
 * Handles both phases:
 * - Phase 1: Portal callback with IdP descriptor → returns Azure AD auth URL
 * - Phase 2: Azure AD callback with auth code → exchanges code, returns tokens
 */
export async function POST(request) {
  try {
    const { sessionId, callbackUrl } = await request.json();

    if (!sessionId || !callbackUrl) {
      return NextResponse.json(
        { error: "Missing required fields: sessionId, callbackUrl" },
        { status: 400 }
      );
    }

    const kiroService = new KiroService();
    const result = await kiroService.resolveEnterpriseCallback(sessionId, callbackUrl);

    return NextResponse.json(result);
  } catch (error) {
    console.log("Enterprise SSO resolve error:", error);
    // Map known client-side errors to 4xx; everything else is a 500.
    const msg = error.message || "";
    let status = 500;
    if (/session not found|session expired/i.test(msg)) {
      status = 404;
    } else if (/state mismatch|csrf/i.test(msg)) {
      status = 401;
    } else if (/invalid callback url|missing client_id|could not parse|leg-2 context|rejected|non-json|missing authorization_endpoint/i.test(msg)) {
      status = 400;
    }
    return NextResponse.json({ error: msg }, { status });
  }
}
