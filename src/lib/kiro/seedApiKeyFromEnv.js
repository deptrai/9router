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

let seedPromise = null;

/**
 * Ensure the Kiro API key is seeded exactly once per process.
 * Called lazily from chat/auth paths so it runs in the same worker that
 * handles the request, regardless of whether initializeApp has run there.
 */
export async function ensureKiroApiKeySeeded() {
  if (seedPromise) return seedPromise;
  if (global.__kiroApiKeySeeded) return;
  seedPromise = seedKiroApiKeyFromEnv().finally(() => {
    global.__kiroApiKeySeeded = true;
  });
  return seedPromise;
}

// In-memory status for observability (no secrets exposed)
export const seedStatus = {
  envPresent: false,
  checkedAt: null,
  existingCount: 0,
  created: false,
  skipped: false,
  error: null,
  profileArn: null,
};

export async function seedKiroApiKeyFromEnv() {
  const apiKey = process.env.KIRO_API_KEY;
  seedStatus.envPresent = !!(apiKey && typeof apiKey === "string" && apiKey.trim());
  seedStatus.checkedAt = new Date().toISOString();
  seedStatus.created = false;
  seedStatus.skipped = false;
  seedStatus.error = null;
  seedStatus.profileArn = null;

  if (!seedStatus.envPresent) {
    return;
  }

  try {
    const region = process.env.KIRO_API_KEY_REGION || "us-east-1";
    const kiroService = new KiroService();

    // Idempotency: avoid creating duplicate connections on every restart/HMR.
    const existing = await getProviderConnections({ provider: "kiro" });
    seedStatus.existingCount = existing.length;
    const alreadyExists = existing.some(
      (c) =>
        c.authType === "apikey" &&
        c.accessToken === apiKey &&
        c.providerSpecificData?.authMethod === "api_key" &&
        c.isActive === 1
    );
    if (alreadyExists) {
      seedStatus.skipped = true;
      console.log("[KiroSeed] API key connection already exists, skipping seed");
      return;
    }

    const credential = await kiroService.validateApiKey(apiKey, region);
    seedStatus.profileArn = credential.profileArn || null;
    const email = kiroService.extractEmailFromJWT(credential.accessToken);

    await createProviderConnection({
      provider: "kiro",
      authType: "apikey",
      name: "Seeded API Key",
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

    seedStatus.created = true;
    console.log("[KiroSeed] API key connection created successfully");
  } catch (error) {
    seedStatus.error = error?.message || String(error);
    console.error("[KiroSeed] Failed to seed Kiro API key:", seedStatus.error);
  }
}
