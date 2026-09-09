import crypto from "node:crypto";

export function verifyTelegramPayload(data, botToken) {
  const { hash, ...fields } = data;
  if (!hash) return false;

  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");

  return hash && computed.length === hash.length && crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
}

export function isTelegramAuthFresh(authDate, maxAgeSeconds = 300) {
  const age = Math.floor(Date.now() / 1000) - Number(authDate);
  return age >= 0 && age <= maxAgeSeconds;
}
