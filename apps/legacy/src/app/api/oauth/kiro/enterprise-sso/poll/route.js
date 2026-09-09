import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";

/**
 * POST /api/oauth/kiro/enterprise-sso/poll
 * Poll for enterprise SSO session completion.
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
    const result = kiroService.pollEnterpriseSsoSession(sessionId);

    return NextResponse.json(result);
  } catch (error) {
    console.log("Enterprise SSO poll error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
