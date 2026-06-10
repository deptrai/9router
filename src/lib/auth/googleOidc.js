import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration";
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const DEFAULT_SCOPES = "openid profile email";

function trimTrailingSlashes(value) {
  return (value || "").trim().replace(/\/+$/, "");
}

export function getPublicOrigin(request) {
  const configuredBaseUrl =
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "";

  if (configuredBaseUrl) {
    return trimTrailingSlashes(configuredBaseUrl);
  }

  const forwardedProto = request?.headers?.get?.("x-forwarded-proto") || "";
  const forwardedHost = request?.headers?.get?.("x-forwarded-host") || "";
  const host = forwardedHost || request?.headers?.get?.("host") || "";
  if (host) {
    const protocol = (forwardedProto || new URL(request.url).protocol || "http:").replace(/:$/, "");
    return `${protocol}://${host}`.replace(/\/+$/, "");
  }

  return trimTrailingSlashes(new URL(request.url).origin);
}

export function isGoogleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function createGoogleState() {
  return crypto.randomBytes(16).toString("base64url");
}

export function createGoogleNonce() {
  return crypto.randomBytes(16).toString("base64url");
}

export async function fetchGoogleDiscovery() {
  const res = await fetch(GOOGLE_DISCOVERY, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load Google OIDC discovery: ${res.status}`);
  }
  return await res.json();
}

export function buildGoogleAuthUrl({ authorizationEndpoint, redirectUri, state, nonce }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", DEFAULT_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("access_type", "offline");
  return url.toString();
}

export async function exchangeGoogleCode({ code, redirectUri, tokenEndpoint }) {
  const endpoint = tokenEndpoint || "https://oauth2.googleapis.com/token";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error_description || data?.error || `Google token exchange failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function verifyGoogleIdToken(idToken, expectedNonce) {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: process.env.GOOGLE_CLIENT_ID,
    nonce: expectedNonce,
  });

  if (payload.email_verified !== true) {
    throw new Error("Google email not verified");
  }
  if (payload.exp && Date.now() > payload.exp * 1000) {
    throw new Error("Google ID token expired");
  }

  return { sub: payload.sub, email: payload.email, name: payload.name };
}

export function pickGoogleDisplayName(payload = {}) {
  return payload.name || payload.given_name || payload.email || payload.sub || "Google user";
}

export function pickGoogleEmail(payload = {}) {
  return payload.email || "";
}
