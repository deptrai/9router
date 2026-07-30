import crypto from "node:crypto";

/**
 * Validate Telegram Web App initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Returns { ok: true, user, queryId, authDate } or { ok: false, error }.
 */
export function validateInitData(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { ok: false, error: "Bot token not configured" };
  }

  if (!initData || typeof initData !== "string") {
    return { ok: false, error: "initData missing" };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    return { ok: false, error: "hash missing" };
  }

  const authDate = Number(params.get("auth_date") || "0");
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 86400) {
    return { ok: false, error: "initData expired" };
  }

  params.delete("hash");
  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== hash) {
    return { ok: false, error: "invalid hash" };
  }

  const userRaw = params.get("user");
  let user = null;
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch {
      return { ok: false, error: "user invalid" };
    }
  }
  if (!user) {
    return { ok: false, error: "user missing" };
  }

  const queryId = params.get("query_id") || null;

  return { ok: true, user, queryId, authDate };
}
