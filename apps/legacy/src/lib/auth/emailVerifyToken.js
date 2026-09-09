/**
 * Email verification token store (Story 2.6, AC2)
 *
 * Uses KV scope "emailVerify". No automatic TTL — expiresAt stored in value,
 * checked manually. Token entropy: 32 bytes = 256 bits (crypto.randomBytes).
 *
 * Two consumption styles:
 *  - consumeEmailVerifyToken: validate + remove atomically-ish (one-time use).
 *  - peekEmailVerifyToken + removeEmailVerifyToken: validate WITHOUT removing,
 *    so the caller removes only AFTER its side-effect (e.g. DB update) commits.
 *    This avoids burning a one-time token when the update fails (review fix).
 */
import crypto from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const kv = makeKv("emailVerify");

// A record is valid only if expiresAt is a number AND in the future.
// Missing/garbage expiresAt is treated as invalid (never "permanently valid").
function hasValidExpiry(data) {
  return data && typeof data.expiresAt === "number" && data.expiresAt >= Date.now();
}

export async function createEmailVerifyToken(userId, email) {
  const token = crypto.randomBytes(32).toString("hex");
  await kv.set(token, {
    userId,
    email,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

export async function consumeEmailVerifyToken(token) {
  if (!token) return null;

  const data = await kv.get(token, null);
  if (!data) return null;

  if (!hasValidExpiry(data)) {
    await kv.remove(token); // clean up expired/invalid token
    return null;
  }

  // One-time use: remove before returning
  await kv.remove(token);
  return { userId: data.userId, email: data.email };
}

/** Validate a token without removing it. Expired/invalid → cleaned up + null. */
export async function peekEmailVerifyToken(token) {
  if (!token) return null;

  const data = await kv.get(token, null);
  if (!data) return null;

  if (!hasValidExpiry(data)) {
    await kv.remove(token);
    return null;
  }

  return { userId: data.userId, email: data.email };
}

/** Remove a token (call after the verification side-effect has committed). */
export async function removeEmailVerifyToken(token) {
  if (!token) return;
  await kv.remove(token);
}
