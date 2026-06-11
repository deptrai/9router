import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/kiro/import
 * Import and validate refresh token from Kiro IDE
 */
export async function POST(request) {
  try {
    const rawBody = await request.json();
    const accounts = Array.isArray(rawBody) ? rawBody : [rawBody];

    if (accounts.length === 0) {
      return NextResponse.json(
        { error: "Refresh token is required" },
        { status: 400 }
      );
    }

    const kiroService = new KiroService();
    const connections = [];

    for (const body of accounts) {
      const refreshToken = body.refreshToken || body.refresh_token;
      const accessToken = body.accessToken || body.access_token;
      const expiresIn = body.expiresIn || body.expires_in || 3600;
      const importedExpiresAt = body.expiresAt || body.expires_at;
      const providerSpecificData = {
        profileArn: body.profileArn || body.profile_arn,
        region: body.region || "us-east-1",
        authMethod: body.authMethod || body.auth_method || "imported",
        clientId: body.clientId || body.client_id,
        clientSecret: body.clientSecret || body.client_secret,
        startUrl: body.startUrl || body.start_url,
      };

      if (!refreshToken || typeof refreshToken !== "string") {
        return NextResponse.json(
          { error: "Refresh token is required" },
          { status: 400 }
        );
      }

      let tokenData;
      if (accessToken && typeof accessToken === "string") {
        tokenData = {
          accessToken: accessToken.trim(),
          refreshToken: refreshToken.trim(),
          profileArn: providerSpecificData.profileArn,
          expiresIn,
          expiresAt: importedExpiresAt,
        };
      } else {
        // Validate and refresh token when the import only supplies refreshToken.
        tokenData = await kiroService.validateImportToken(refreshToken.trim(), providerSpecificData);
      }

      // Extract email from JWT if available
      const email = body.email || kiroService.extractEmailFromJWT(tokenData.accessToken);
      const parsedExpiresAt = tokenData.expiresAt ? new Date(tokenData.expiresAt) : null;
      const expiresAt = parsedExpiresAt && !Number.isNaN(parsedExpiresAt.getTime())
        ? parsedExpiresAt.toISOString()
        : new Date(Date.now() + tokenData.expiresIn * 1000).toISOString();

      // Save to database
      const connection = await createProviderConnection({
        provider: "kiro",
        authType: "oauth",
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        expiresAt,
        email: email || null,
        providerSpecificData: {
          profileArn: tokenData.profileArn || providerSpecificData.profileArn,
          region: providerSpecificData.region,
          authMethod: providerSpecificData.authMethod,
          clientId: providerSpecificData.clientId,
          clientSecret: providerSpecificData.clientSecret,
          startUrl: providerSpecificData.startUrl,
          provider: providerSpecificData.authMethod === "idc" ? "IDC" : "Imported",
        },
        testStatus: "active",
      });

      connections.push(connection);
    }

    const responseConnections = connections.map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      email: connection.email,
    }));

    return NextResponse.json({
      success: true,
      connection: responseConnections[0],
      connections: responseConnections,
    });
  } catch (error) {
    console.log("Kiro import token error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
