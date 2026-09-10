import crypto from 'node:crypto';
import { TelegramInitDataResult, TelegramUserDto } from '@repo/shared-types';

/**
 * Validates Telegram Web App initData cryptographically according to the official Bot API specs.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

const MAX_INIT_DATA_BYTES = 4096;

export function validateTelegramInitData(
  initData: string,
  botToken: string
): TelegramInitDataResult {
  if (!botToken) {
    return { ok: false, error: 'Bot token not configured' };
  }

  if (typeof initData !== 'string' || !initData) {
    return { ok: false, error: 'initData missing' };
  }

  if (Buffer.byteLength(initData, 'utf8') > MAX_INIT_DATA_BYTES) {
    return { ok: false, error: 'initData too large' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) {
    return { ok: false, error: 'hash missing' };
  }

  const authDateRaw = params.get('auth_date');
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  const now = Math.floor(Date.now() / 1000);

  // Reject if auth_date is missing, not an integer, older than 24 hours (86,400s)
  // or more than 60s in the future (clock drift)
  if (
    !Number.isInteger(authDate) ||
    authDate <= 0 ||
    now - authDate >= 86400 ||
    authDate > now + 60
  ) {
    return { ok: false, error: 'initData expired' };
  }

  // Build dataCheckString by sorting all pairs alphabetically by key, excluding hash
  params.delete('hash');
  const pairs: [string, string][] = [];
  for (const [key, value] of params.entries()) {
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([key, value]) => `${key}=${value}`).join('\n');

  // Telegram WebApp HMAC-SHA256 signature algorithm
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (
    hash.length !== 64 ||
    calculatedHash.length !== 64 ||
    !/^[0-9a-f]+$/i.test(hash)
  ) {
    return { ok: false, error: 'invalid hash' };
  }

  const a = Buffer.from(calculatedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'invalid hash' };
  }

  const userRaw = params.get('user');
  let userObj: Record<string, unknown> | null = null;
  if (userRaw) {
    try {
      const parsed: unknown = JSON.parse(userRaw);
      if (parsed && typeof parsed === 'object') {
        userObj = parsed as Record<string, unknown>;
      }
    } catch {
      return { ok: false, error: 'user invalid' };
    }
  }

  if (!userObj) {
    return { ok: false, error: 'user missing' };
  }

  const id = userObj.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, error: 'user missing' };
  }

  const isBotValue = userObj.is_bot;
  const isBot =
    isBotValue === true ||
    isBotValue === 'true' ||
    isBotValue === 1 ||
    isBotValue === '1';
  if (isBot) {
    return { ok: false, error: 'bot not allowed' };
  }

  const user: TelegramUserDto = {
    id,
    username: typeof userObj.username === 'string' ? userObj.username : null,
    firstName: typeof userObj.first_name === 'string' ? userObj.first_name : '',
    lastName: typeof userObj.last_name === 'string' ? userObj.last_name : null,
    languageCode: typeof userObj.language_code === 'string' ? userObj.language_code : null,
    isPremium: userObj.is_premium === true,
  };

  const queryId = params.get('query_id') || null;

  return { ok: true, user, queryId, authDate };
}
