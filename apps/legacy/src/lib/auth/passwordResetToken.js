/**
 * Password reset token store (Story 2.7)
 * KV scope "passwordReset", TTL 1h, one-time use.
 */
import crypto from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const kv = makeKv("passwordReset");

async function invalidateUserPasswordResetTokens(userId) {
  const all = await kv.getAll(); // { token: {userId, email, expiresAt} }
  await Promise.all(
    Object.entries(all)
      .filter(([, value]) => value?.userId === userId)
      .map(([key]) => kv.remove(key))
  );
}

export async function createPasswordResetToken(userId, email) {
  await invalidateUserPasswordResetTokens(userId);
  const token = crypto.randomBytes(32).toString("hex");
  await kv.set(token, {
    userId,
    email,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

/** Validate token without consuming — use before side-effects to prevent token loss on DB failure. */
export async function peekPasswordResetToken(token) {
  if (!token) return null;
  const data = await kv.get(token, null);
  if (!data) return null;
  if (data.expiresAt < Date.now()) {
    await kv.remove(token);
    return null;
  }
  return { userId: data.userId, email: data.email };
}

/** Remove token (call after side-effect has committed). */
export async function removePasswordResetToken(token) {
  if (!token) return;
  await kv.remove(token);
}

export async function consumePasswordResetToken(token) {
  if (!token) return null;
  const data = await kv.get(token, null);
  if (!data) return null;
  if (data.expiresAt < Date.now()) {
    await kv.remove(token);
    return null;
  }
  await kv.remove(token);
  return { userId: data.userId, email: data.email };
}
