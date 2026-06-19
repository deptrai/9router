import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";

/**
 * POST /api/oauth/kiro/enterprise-sso/cancel
 * Cancel an in-flight enterprise SSO session.
 */
export async function POST(request) {
  try {
    const { sessionId } = await request.json();

    if (!sessionId) {
      return NextResponse.json(
        { error: "Missing sessionId" },
        { status: 400 }
      );
    }

    const kiroService = new KiroService();
    kiroService.cancelEnterpriseSsoSession(sessionId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Enterprise SSO cancel error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
