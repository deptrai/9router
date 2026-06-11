/**
 * secretBox — AES-256-GCM encrypt/decrypt for credential payloads at rest (Story 2.27, NFR8)
 *
 * Key source: STORE_ENC_KEY env var (hex 64 chars = 32 bytes, or base64 44 chars = 32 bytes).
 * Generate: openssl rand -hex 32
 *
 * Blob format: base64(iv) + "." + base64(authTag) + "." + base64(ciphertext)
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function loadKey() {
  const raw = process.env.STORE_ENC_KEY;
  if (!raw) throw new Error("STORE_ENC_KEY is required for credential encryption — set it in .env");
  const buf = raw.length === 64
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("STORE_ENC_KEY must be 32 bytes (hex 64 chars or base64 44 chars)");
  }
  return buf;
}

/**
 * Encrypt plaintext string → opaque blob (iv.tag.ct, all base64).
 * Never logs key or plaintext.
 */
export function encrypt(plaintext) {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

/**
 * Decrypt a blob produced by encrypt(). Throws on tampered tag or wrong key.
 */
export function decrypt(blob) {
  const key = loadKey();
  const parts = blob.split(".");
  if (parts.length !== 3) throw new Error("secretBox.decrypt: invalid blob format");
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const ct = Buffer.from(parts[2], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, "utf8") + decipher.final("utf8");
}
