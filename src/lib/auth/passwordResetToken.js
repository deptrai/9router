/**
 * Password reset token store (Story 2.7)
 * KV scope "passwordReset", TTL 1h, one-time use.
 */
import crypto from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const kv = makeKv("passwordReset");

export async function createPasswordResetToken(userId, email) {
  const token = crypto.randomBytes(32).toString("hex");
  await kv.set(token, {
    userId,
    email,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

export async function consumePasswordResetToken(token) {
  if (!token) return null;

  const data = await kv.get(token, null);
  if (!data) return null;

  if (data.expiresAt < Date.now()) {
    await kv.remove(token);
    return null;
  }

  await kv.remove(token); // one-time use
  return { userId: data.userId, email: data.email };
}
