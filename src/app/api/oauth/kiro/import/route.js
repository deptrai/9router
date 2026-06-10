import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/kiro/import
 * Import and validate refresh token from Kiro IDE
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const refreshToken = body.refreshToken || body.refresh_token;
    const providerSpecificData = {
      profileArn: body.profileArn || body.profile_arn,
      region: body.region || "us-east-1",
      authMethod: body.authMethod || body.auth_method || "imported",
      clientId: body.clientId || body.client_id,
      clientSecret: body.clientSecret || body.client_secret,
    };

    if (!refreshToken || typeof refreshToken !== "string") {
      return NextResponse.json(
        { error: "Refresh token is required" },
        { status: 400 }
      );
    }

    const kiroService = new KiroService();

    // Validate and refresh token
    const tokenData = await kiroService.validateImportToken(refreshToken.trim(), providerSpecificData);

    // Extract email from JWT if available
    const email = kiroService.extractEmailFromJWT(tokenData.accessToken);

    // Save to database
    const connection = await createProviderConnection({
      provider: "kiro",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: new Date(Date.now() + tokenData.expiresIn * 1000).toISOString(),
      email: email || null,
      providerSpecificData: {
        profileArn: tokenData.profileArn || providerSpecificData.profileArn,
        region: providerSpecificData.region,
        authMethod: providerSpecificData.authMethod,
        clientId: providerSpecificData.clientId,
        clientSecret: providerSpecificData.clientSecret,
        provider: providerSpecificData.authMethod === "idc" ? "IDC" : "Imported",
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.log("Kiro import token error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
