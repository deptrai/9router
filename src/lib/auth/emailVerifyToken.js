/**
 * Email verification token store (Story 2.6, AC2)
 *
 * Uses KV scope "emailVerify". No automatic TTL — expiresAt stored in value,
 * checked manually on consume. One-time use: token removed after first valid consume.
 *
 * Token entropy: 32 bytes = 256 bits (crypto.randomBytes).
 */
import crypto from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const kv = makeKv("emailVerify");

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

  // Check expiry
  if (data.expiresAt < Date.now()) {
    await kv.remove(token); // clean up expired token
    return null;
  }

  // One-time use: remove before returning
  await kv.remove(token);
  return { userId: data.userId, email: data.email };
}
