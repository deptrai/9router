/**
 * Seed a shared Kiro API-key connection from environment on startup.
 *
 * This lets production deployments rotate/re-issue a long-lived Kiro key
 * without logging into the dashboard: set KIRO_API_KEY (and optionally
 * KIRO_API_KEY_REGION, default us-east-1) and redeploy.
 *
 * The seed is idempotent: if a connection with the same accessToken already
 * exists, nothing is inserted. Errors are logged but do not block startup.
 */
import { KiroService } from "@/lib/oauth/services/kiro.js";
import { createProviderConnection, getProviderConnections } from "@/models";

export async function seedKiroApiKeyFromEnv() {
  const apiKey = process.env.KIRO_API_KEY;
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return;
  }

  try {
    const region = process.env.KIRO_API_KEY_REGION || "us-east-1";
    const kiroService = new KiroService();

    // Idempotency: avoid creating duplicate connections on every restart/HMR.
    const existing = await getProviderConnections({ provider: "kiro" });
    const alreadyExists = existing.some(
      (c) =>
        c.authType === "apikey" &&
        c.accessToken === apiKey &&
        c.providerSpecificData?.authMethod === "api_key" &&
        c.isActive === 1
    );
    if (alreadyExists) {
      console.log("[KiroSeed] API key connection already exists, skipping seed");
      return;
    }

    const credential = await kiroService.validateApiKey(apiKey, region);
    const email = kiroService.extractEmailFromJWT(credential.accessToken);

    await createProviderConnection({
      provider: "kiro",
      authType: "apikey",
      accessToken: credential.accessToken,
      refreshToken: null,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      email: email || null,
      providerSpecificData: {
        profileArn: credential.profileArn,
        region: credential.region,
        authMethod: "api_key",
        provider: "API Key",
      },
      testStatus: "active",
    });

    console.log("[KiroSeed] API key connection created successfully");
  } catch (error) {
    console.error("[KiroSeed] Failed to seed Kiro API key:", error?.message || error);
  }
}
