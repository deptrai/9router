import crypto from "crypto";
import { KIRO_CONFIG, ALLOWED_EXTERNAL_IDP_ISSUER_SUFFIXES } from "../constants/oauth.js";
import { generatePKCE } from "../utils/pkce";

/**
 * Kiro OAuth Service
 * Supports multiple authentication methods:
 * 1. AWS Builder ID (Device Code Flow)
 * 2. AWS IAM Identity Center/IDC (Device Code Flow)
 * 3. Google/GitHub Social Login (Authorization Code Flow + Manual Callback)
 * 4. Import Token (Manual refresh token paste)
 * 5. Enterprise SSO - Microsoft 365 (Two-phase manual callback via Kiro portal + Azure AD)
 */

const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";
const KIRO_SSO_SIGNIN_URL = "https://app.kiro.dev/signin";
const KIRO_SSO_REDIRECT_URI = "http://localhost:3128";
const KIRO_SSO_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// In-memory session store (server-side only)
const ssoSessions = new Map();

export class KiroService {
  /**
   * Register OIDC client with AWS SSO
   * Returns clientId and clientSecret for device code flow
   */
  async registerClient(region = "us-east-1") {
    const endpoint = `https://oidc.${region}.amazonaws.com/client/register`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientName: KIRO_CONFIG.clientName,
        clientType: KIRO_CONFIG.clientType,
        scopes: KIRO_CONFIG.scopes,
        grantTypes: KIRO_CONFIG.grantTypes,
        issuerUrl: KIRO_CONFIG.issuerUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to register client: ${error}`);
    }

    const data = await response.json();
    return {
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      clientSecretExpiresAt: data.clientSecretExpiresAt,
    };
  }

  /**
   * Start device authorization for AWS Builder ID or IDC
   */
  async startDeviceAuthorization(clientId, clientSecret, startUrl, region = "us-east-1") {
    const endpoint = `https://oidc.${region}.amazonaws.com/device_authorization`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to start device authorization: ${error}`);
    }

    const data = await response.json();
    return {
      deviceCode: data.deviceCode,
      userCode: data.userCode,
      verificationUri: data.verificationUri,
      verificationUriComplete: data.verificationUriComplete,
      expiresIn: data.expiresIn,
      interval: data.interval || 5,
    };
  }

  /**
   * Poll for token using device code (AWS Builder ID/IDC)
   */
  async pollDeviceToken(clientId, clientSecret, deviceCode, region = "us-east-1") {
    const endpoint = `https://oidc.${region}.amazonaws.com/token`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await response.json();

    // Handle pending/slow_down/errors
    if (!response.ok || data.error) {
      return {
        success: false,
        error: data.error,
        errorDescription: data.error_description,
        pending: data.error === "authorization_pending" || data.error === "slow_down",
      };
    }

    return {
      success: true,
      tokens: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
        tokenType: data.tokenType,
      },
    };
  }

  /**
   * Build Google/GitHub social login URL
   * Returns authorization URL for manual callback flow
   * Uses kiro:// custom protocol as required by AWS Cognito whitelist
   */
  buildSocialLoginUrl(provider, codeChallenge, state) {
    const idp = provider === "google" ? "Google" : "Github";
    // AWS Cognito only whitelists kiro:// protocol, not localhost
    const redirectUri = "kiro://kiro.kiroAgent/authenticate-success";
    return `${KIRO_AUTH_SERVICE}/login?idp=${idp}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}&prompt=select_account`;
  }

  /**
   * Exchange authorization code for tokens (Social Login)
   * Must use same redirect_uri as authorization request
   */
  async exchangeSocialCode(code, codeVerifier) {
    // Must match the redirect_uri used in buildSocialLoginUrl
    const redirectUri = "kiro://kiro.kiroAgent/authenticate-success";

    const response = await fetch(`${KIRO_AUTH_SERVICE}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn || 3600,
    };
  }

  /**
   * Refresh token using refresh token
   */
  async refreshToken(refreshToken, providerSpecificData = {}) {
    const { authMethod, clientId, clientSecret, region, tokenEndpoint, scopes } = providerSpecificData;

    // External IdP refresh (Enterprise SSO - Microsoft 365 / Azure AD)
    // Tokens refresh against the IdP token endpoint (OAuth2 refresh_token grant, public client)
    if (authMethod === "external_idp") {
      return this.refreshExternalIdpToken(refreshToken, clientId, tokenEndpoint, scopes);
    }

    // AWS SSO OIDC refresh (Builder ID or IDC)
    if (clientId && clientSecret) {
      const endpoint = `https://oidc.${region || "us-east-1"}.amazonaws.com/token`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          clientSecret,
          refreshToken,
          grantType: "refresh_token",
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
      }

      const data = await response.json();
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshToken,
        expiresIn: data.expiresIn,
      };
    }

    // Social auth refresh (Google/GitHub)
    const response = await fetch(`${KIRO_AUTH_SERVICE}/refreshToken`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn || 3600,
    };
  }

  /**
   * Refresh an external IdP (Azure AD) access token using the OAuth2 refresh_token grant.
   * Uses form-encoded POST per OAuth2 spec.
   */
  async refreshExternalIdpToken(refreshToken, clientId, tokenEndpoint, scopes) {
    if (!clientId || !tokenEndpoint) {
      throw new Error("External IdP refresh requires clientId and tokenEndpoint");
    }
    // SSRF guard: never POST the refresh token to an endpoint outside the allow-list.
    const endpointVal = this.validateExternalIdpEndpoint(tokenEndpoint);
    if (!endpointVal.valid) {
      throw new Error(`External IdP token endpoint rejected: ${endpointVal.error}`);
    }

    const params = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (scopes) {
      params.set("scope", scopes);
    }

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
      redirect: "manual",
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`External IdP token refresh returned a non-JSON response (status ${response.status})`);
    }

    if (!response.ok || !data.access_token) {
      throw new Error(
        `External IdP token refresh failed: ${data.error || response.status} ${data.error_description || ""}`
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in || 3600,
    };
  }

  /**
   * Validate a long-lived Kiro API key by calling ListAvailableProfiles.
   * Returns a credential object (accessToken=the raw key, profileArn, region)
   * ready to persist as a "kiro" connection with authMethod="api_key".
   */
  async validateApiKey(apiKey, region = "us-east-1") {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw new Error("API key is required");
    }
    const trimmed = apiKey.trim();

    let profileArn = null;
    try {
      profileArn = await this.listAvailableProfiles(trimmed, region);
    } catch {
      // ListAvailableProfiles may fail for API keys (empty profiles array,
      // insufficient permissions, etc.) — the key is still valid for chat.
      // Proceed without profileArn.
    }

    return {
      accessToken: trimmed,
      refreshToken: null,
      profileArn,
      region,
      authMethod: "api_key",
    };
  }

  /**
   * List available profiles from CodeWhisperer API (validates API key)
   */
  async listAvailableProfiles(apiKey, region = "us-east-1") {
    const endpoint = "https://codewhisperer.us-east-1.amazonaws.com";
    const target = "AmazonCodeWhispererService.ListAvailableProfiles";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": target,
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      body: JSON.stringify({ maxResults: 1 }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Profile listing failed: ${error}`);
    }

    const data = await response.json();
    const profiles = data.profiles || [];
    if (profiles.length === 0) {
      return null;
    }
    return profiles[0].profileArn;
  }

  /**
   * Validate and import refresh token
   */
  async validateImportToken(refreshToken, providerSpecificData = {}) {
    // Skip format validation for external_idp (M365/Azure AD) tokens — they don't use
    // the AWS SSO "aorAAAAAG" prefix. Validate by attempting a refresh instead.
    if (providerSpecificData.authMethod !== "external_idp" && !refreshToken.startsWith("aorAAAAAG")) {
      throw new Error("Invalid token format. Token should start with aorAAAAAG...");
    }

    // Try to refresh to validate
    try {
      const result = await this.refreshToken(refreshToken, providerSpecificData);
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || refreshToken,
        profileArn: result.profileArn,
        expiresIn: result.expiresIn,
        authMethod: providerSpecificData.authMethod || "imported",
      };
    } catch (error) {
      throw new Error(`Token validation failed: ${error.message}`);
    }
  }

  /**
   * List available models from CodeWhisperer API
   */
  async listAvailableModels(accessToken, profileArn, authMethod) {
    const endpoint = "https://codewhisperer.us-east-1.amazonaws.com";
    const target = "AmazonCodeWhispererService.ListAvailableModels";

    const headers = {
      "Content-Type": "application/x-amz-json-1.0",
      "x-amz-target": target,
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
    };
    if (authMethod === "external_idp") {
      headers["TokenType"] = "EXTERNAL_IDP";
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        origin: "AI_EDITOR",
        profileArn,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list models: ${error}`);
    }

    const data = await response.json();
    return (data.models || []).map(m => ({
      id: m.modelId,
      name: m.modelName || m.modelId,
      description: m.description,
      rateMultiplier: m.rateMultiplier,
      rateUnit: m.rateUnit,
      maxInputTokens: m.tokenLimits?.maxInputTokens || 0,
    }));
  }

  /**
   * Fetch user email from access token (optional, for display)
   */
  extractEmailFromJWT(accessToken) {
    try {
      const parts = accessToken.split(".");
      if (parts.length !== 3) return null;

      let payload = parts[1];
      while (payload.length % 4) {
        payload += "=";
      }

      const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      return decoded.email || decoded.preferred_username || decoded.sub;
    } catch {
      return null;
    }
  }

  // ─── Enterprise SSO - Microsoft 365 ───────────────────────────────────────

  /**
   * Validate that an external IdP endpoint URL is https and host is allow-listed.
   * Prevents SSRF/open-redirect abuse via forged portal callback.
   */
  validateExternalIdpEndpoint(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return { valid: false, error: "Invalid URL" };
    }
    if (u.protocol !== "https:") {
      return { valid: false, error: "URL must be https" };
    }
    const host = u.hostname.toLowerCase();
    if (!host) {
      return { valid: false, error: "URL has no host" };
    }
    // Reject IP literals
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || /^\[/.test(host)) {
      return { valid: false, error: "Host must not be an IP literal" };
    }
    const allowed = ALLOWED_EXTERNAL_IDP_ISSUER_SUFFIXES || [
      ".microsoftonline.com",
      ".microsoftonline.us",
      ".microsoftonline.cn",
    ];
    const matched = allowed.some((suffix) => host.endsWith(suffix));
    if (!matched) {
      return { valid: false, error: `Host ${host} is not allow-listed` };
    }
    return { valid: true };
  }

  /**
   * OIDC discovery: fetch the OpenID Connect configuration from the issuer URL.
   * Both the issuer and discovered endpoints are validated against the allow-list.
   */
  async discoverOIDC(issuerURL) {
    const validation = this.validateExternalIdpEndpoint(issuerURL);
    if (!validation.valid) {
      throw new Error(`Issuer rejected: ${validation.error}`);
    }
    const docURL = issuerURL.replace(/\/+$/, "") + "/.well-known/openid-configuration";

    const response = await fetch(docURL, {
      headers: { Accept: "application/json" },
      // Do not follow redirects (SSRF prevention)
      redirect: "manual",
    });

    if (!response.ok) {
      throw new Error(`OIDC discovery failed (status ${response.status})`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("OIDC discovery returned a non-JSON response");
    }
    if (!data.authorization_endpoint || !data.token_endpoint) {
      throw new Error("OIDC discovery missing authorization_endpoint or token_endpoint");
    }

    // Validate both discovered endpoints
    const authVal = this.validateExternalIdpEndpoint(data.authorization_endpoint);
    if (!authVal.valid) {
      throw new Error(`Discovered authorization_endpoint rejected: ${authVal.error}`);
    }
    const tokenVal = this.validateExternalIdpEndpoint(data.token_endpoint);
    if (!tokenVal.valid) {
      throw new Error(`Discovered token_endpoint rejected: ${tokenVal.error}`);
    }

    return {
      authorizationEndpoint: data.authorization_endpoint,
      tokenEndpoint: data.token_endpoint,
    };
  }

  /**
   * Build the Kiro portal sign-in URL for enterprise SSO.
   * The portal handles email detection and redirects with IdP descriptor.
   */
  buildEnterpriseSSOUrl(sessionId, codeChallenge) {
    const params = new URLSearchParams({
      state: sessionId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: KIRO_SSO_REDIRECT_URI,
      redirect_from: "9router",
    });
    return `${KIRO_SSO_SIGNIN_URL}?${params.toString()}`;
  }

  /**
   * Build Azure AD authorization URL (enterprise leg-2).
   * Redirects the user's browser to Azure AD for M365 login.
   */
  buildAzureADAuthUrl(authEndpoint, clientId, redirectURI, scopes, codeChallenge, state, loginHint) {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectURI,
      scope: scopes,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_mode: "query",
      state,
    });
    if (loginHint) {
      params.set("login_hint", loginHint);
    }
    return `${authEndpoint}?${params.toString()}`;
  }

  /**
   * Parse the Kiro portal callback URL query and extract the enterprise IdP descriptor.
   * Expected params: issuer_url, client_id, scopes, login_hint, login_option
   */
  parseIdPDescriptor(callbackUrl) {
    let u;
    try {
      u = new URL(callbackUrl);
    } catch {
      throw new Error("Invalid callback URL");
    }

    const q = u.searchParams;
    const issuerURL = q.get("issuer_url");
    const clientID = q.get("client_id");
    const scopes = q.get("scopes");
    const loginHint = q.get("login_hint");
    const loginOption = q.get("login_option");

    // The portal (leg-1) descriptor always carries issuer_url. Requiring it here
    // disambiguates a leg-2 Azure callback that happens to include client_id but
    // no issuer_url (which must be routed to the auth-code branch instead).
    if (!issuerURL) {
      return { kind: "unknown" };
    }

    if (!clientID) {
      throw new Error("Invalid IdP descriptor: missing client_id");
    }

    return {
      kind: "external_idp",
      issuerURL,
      clientID,
      scopes: this.ensureRefreshScopes(scopes),
      loginHint: loginHint || "",
      loginOption: loginOption || "",
    };
  }

  /**
   * Ensure the scope string includes the scopes required for a usable enterprise
   * token: `openid` (OIDC) and `offline_access` (so Azure AD returns a refresh
   * token). Without offline_access the IdP returns no refresh_token and the
   * connection cannot be refreshed or even saved.
   */
  ensureRefreshScopes(scopes) {
    const base = (scopes || "openid profile email").trim();
    const parts = base.split(/\s+/).filter(Boolean);
    const lower = new Set(parts.map((p) => p.toLowerCase()));
    if (!lower.has("openid")) parts.unshift("openid");
    if (!lower.has("offline_access")) parts.push("offline_access");
    return parts.join(" ");
  }

  /**
   * Parse the Azure AD callback URL and extract the authorization code.
   * Expected params: code, state
   */
  parseAzureADCallback(callbackUrl) {
    let u;
    try {
      u = new URL(callbackUrl);
    } catch {
      throw new Error("Invalid callback URL");
    }

    const q = u.searchParams;
    const code = q.get("code");
    const state = q.get("state");
    const error = q.get("error");
    const errorDesc = q.get("error_description");

    if (error) {
      throw new Error(`Azure AD authorization error: ${error} ${errorDesc || ""}`);
    }

    if (!code) {
      return { kind: "unknown" };
    }

    return {
      kind: "auth_code",
      code,
      state: state || null,
    };
  }

  /**
   * Exchange Azure AD authorization code for tokens at the IdP token endpoint.
   * Standard OAuth2 authorization_code grant with PKCE (public client, no secret).
   */
  async exchangeAzureADCode(tokenEndpoint, clientId, code, codeVerifier, redirectURI, scopes) {
    // SSRF guard: the token endpoint comes from OIDC discovery (already validated),
    // but re-check here so this method is safe regardless of caller.
    const endpointVal = this.validateExternalIdpEndpoint(tokenEndpoint);
    if (!endpointVal.valid) {
      throw new Error(`Azure AD token endpoint rejected: ${endpointVal.error}`);
    }

    const params = new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code: code.trim(),
      redirect_uri: redirectURI,
      code_verifier: codeVerifier,
    });
    if (scopes) {
      params.set("scope", scopes);
    }

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
      redirect: "manual",
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Azure AD token exchange returned a non-JSON response (status ${response.status})`);
    }

    if (!response.ok || !data.access_token) {
      throw new Error(
        `Azure AD token exchange failed: ${data.error || response.status} ${data.error_description || ""}`
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || "",
      expiresIn: data.expires_in || 3600,
      idToken: data.id_token || "",
    };
  }

  /**
   * Start an enterprise SSO session.
   * Returns the session ID and the Kiro portal sign-in URL.
   */
  startEnterpriseSsoSession() {
    if (typeof window !== "undefined") {
      throw new Error("startEnterpriseSsoSession must be called server-side");
    }
    // Opportunistic sweep: drop expired/abandoned sessions so the in-memory store
    // does not grow unbounded (no background timer is used).
    const now = Date.now();
    for (const [id, s] of ssoSessions) {
      if (now > s.expiresAt) ssoSessions.delete(id);
    }
    const sessionId = crypto.randomUUID();
    const pkce = generatePKCE();
    const signInUrl = this.buildEnterpriseSSOUrl(sessionId, pkce.codeChallenge);
    const session = {
      id: sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + KIRO_SSO_TIMEOUT_MS,
      portalPKCE: pkce,
      leg2: null, // will hold second leg PKCE + OIDC params
    };
    ssoSessions.set(sessionId, session);
    return { sessionId, signInUrl };
  }

  /**
   * Start an enterprise SSO session DIRECTLY against Azure AD, bypassing the
   * Kiro portal. The caller provides the tenant-specific OIDC parameters
   * (issuerURL, clientID, scopes) which are normally obtained from the portal's
   * IdP descriptor.
   *
   * This is the preferred path when the user already knows these values
   * (e.g. from a previous portal callback) and wants to avoid the extra
   * portal round-trip.
   */
  async startDirectEnterpriseSsoSession({ email, issuerURL, clientID, scopes }) {
    if (typeof window !== "undefined") {
      throw new Error("startDirectEnterpriseSsoSession must be called server-side");
    }
    if (!issuerURL || !clientID) {
      throw new Error("Missing required direct SSO parameters: issuerURL, clientID");
    }

    const sessionId = crypto.randomUUID();
    const pkce = generatePKCE();

    // Discover OIDC endpoints from the issuer
    const oidc = await this.discoverOIDC(issuerURL);

    const leg2State = crypto.randomUUID();
    const legRedirectURI = `${KIRO_SSO_REDIRECT_URI}/oauth/callback`;
    const finalScopes = this.ensureRefreshScopes(scopes);

    const session = {
      id: sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + KIRO_SSO_TIMEOUT_MS,
      portalPKCE: null, // no portal leg for direct mode
      leg2: {
        pkce,
        state: leg2State,
        tokenEndpoint: oidc.tokenEndpoint,
        issuerURL,
        clientID,
        scopes: finalScopes,
        redirectURI: legRedirectURI,
        loginHint: email || "",
        authorizationEndpoint: oidc.authorizationEndpoint,
      },
    };
    ssoSessions.set(sessionId, session);

    const authUrl = this.buildAzureADAuthUrl(
      oidc.authorizationEndpoint,
      clientID,
      legRedirectURI,
      finalScopes,
      pkce.codeChallenge,
      leg2State,
      email
    );

    return { sessionId, authUrl };
  }

  /**
   * Resolve a callback URL against an in-flight enterprise SSO session.
   * Handles both:
   * 1. Portal callback (IdP descriptor) → discovers OIDC, returns Azure AD auth URL
   * 2. Azure AD callback (auth code) → exchanges code, returns tokens
   */
  async resolveEnterpriseCallback(sessionId, callbackUrl) {
    const session = ssoSessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found or expired");
    }
    if (Date.now() > session.expiresAt) {
      ssoSessions.delete(sessionId);
      throw new Error("Session expired");
    }

    // Try to parse as IdP descriptor (portal callback)
    const descriptor = this.parseIdPDescriptor(callbackUrl);
    if (descriptor.kind === "external_idp") {
      // Phase 1: Portal callback with IdP descriptor
      // Discover OIDC endpoints from the issuer
      const oidc = await this.discoverOIDC(descriptor.issuerURL);

      // Generate PKCE for leg-2 (Azure AD)
      const leg2PKCE = generatePKCE();
      const leg2State = crypto.randomUUID();
      const legRedirectURI = `${KIRO_SSO_REDIRECT_URI}/oauth/callback`;

      session.leg2 = {
        pkce: leg2PKCE,
        state: leg2State,
        tokenEndpoint: oidc.tokenEndpoint,
        issuerURL: descriptor.issuerURL,
        clientID: descriptor.clientID,
        scopes: descriptor.scopes,
        redirectURI: legRedirectURI,
        loginHint: descriptor.loginHint,
        authorizationEndpoint: oidc.authorizationEndpoint,
      };

      const authUrl = this.buildAzureADAuthUrl(
        oidc.authorizationEndpoint,
        descriptor.clientID,
        legRedirectURI,
        descriptor.scopes,
        leg2PKCE.codeChallenge,
        leg2State,
        descriptor.loginHint
      );

      return {
        phase: "azure_ad",
        authUrl,
        state: leg2State,
      };
    }

    // Try to parse as Azure AD callback (auth code)
    const azureResult = this.parseAzureADCallback(callbackUrl);
    if (azureResult.kind === "auth_code") {
      // Phase 2: Azure AD callback with auth code
      const leg2 = session.leg2;
      if (!leg2) {
        throw new Error("No enterprise SSO leg-2 context found. Please start over.");
      }
      // State is mandatory and must match (anti-CSRF / auth-code injection).
      if (!azureResult.state || azureResult.state !== leg2.state) {
        throw new Error("State mismatch: CSRF validation failed");
      }

      const tokens = await this.exchangeAzureADCode(
        leg2.tokenEndpoint,
        leg2.clientID,
        azureResult.code,
        leg2.pkce.codeVerifier,
        leg2.redirectURI,
        leg2.scopes
      );

      // Azure AD access tokens are frequently opaque (non-JWT) or audience-scoped,
      // so the email may not be extractable from them. Fall back to the id_token
      // claims, then to the portal-provided login_hint, so connection dedup works.
      const email =
        this.extractEmailFromJWT(tokens.accessToken) ||
        this.extractEmailFromJWT(tokens.idToken) ||
        (leg2.loginHint || null);
      const result = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        email,
        authMethod: "external_idp",
        clientID: leg2.clientID,
        tokenEndpoint: leg2.tokenEndpoint,
        issuerURL: leg2.issuerURL,
        scopes: leg2.scopes,
      };

      // The caller receives the result inline; tear the session down immediately so
      // plaintext tokens do not linger in the in-memory store.
      ssoSessions.delete(sessionId);

      return {
        phase: "completed",
        result,
      };
    }

    throw new Error("Could not parse callback URL. Expected either IdP descriptor or auth code.");
  }

  /**
   * Poll for enterprise SSO session completion.
   * Returns pending until the session has a result.
   */
  pollEnterpriseSsoSession(sessionId) {
    const session = ssoSessions.get(sessionId);
    if (!session) {
      return { status: "not_found" };
    }
    if (Date.now() > session.expiresAt) {
      ssoSessions.delete(sessionId);
      return { status: "expired" };
    }
    if (session.result) {
      return { status: "completed", result: session.result };
    }
    return { status: "pending" };
  }

  /**
   * Cancel an in-flight enterprise SSO session.
   */
  cancelEnterpriseSsoSession(sessionId) {
    const session = ssoSessions.get(sessionId);
    if (session) {
      ssoSessions.delete(sessionId);
    }
  }
}
