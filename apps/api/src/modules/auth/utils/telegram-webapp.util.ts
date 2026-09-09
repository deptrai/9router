import crypto from 'node:crypto';
import { TelegramInitDataResult, TelegramUserDto } from '@repo/shared-types';

/**
 * Validates Telegram Web App initData cryptographically according to the official Bot API specs.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateTelegramInitData(
  initData: string,
  botToken: string
): TelegramInitDataResult {
  if (!botToken) {
    return { ok: false, error: 'Bot token not configured' };
  }

  if (!initData || typeof initData !== 'string') {
    return { ok: false, error: 'initData missing' };
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
  let userObj: unknown = null;
  if (userRaw) {
    try {
      userObj = JSON.parse(userRaw);
    } catch {
      return { ok: false, error: 'user invalid' };
    }
  }

  if (
    !userObj ||
    typeof userObj !== 'object' ||
    !('id' in userObj) ||
    typeof (userObj as { id: unknown }).id !== 'number' ||
    !Number.isSafeInteger((userObj as { id: number }).id) ||
    (userObj as { id: number }).id <= 0
  ) {
    return { ok: false, error: 'user missing' };
  }

  const typedUser = userObj as {
    id: number;
    is_bot?: unknown;
    username?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    language_code?: unknown;
    is_premium?: unknown;
  };

  const isBot =
    typedUser.is_bot === true ||
    typedUser.is_bot === 'true' ||
    typedUser.is_bot === 1 ||
    typedUser.is_bot === '1';
  if (isBot) {
    return { ok: false, error: 'bot not allowed' };
  }

  const user: TelegramUserDto = {
    id: typedUser.id,
    username: typeof typedUser.username === 'string' ? typedUser.username : null,
    firstName: typeof typedUser.first_name === 'string' ? typedUser.first_name : '',
    lastName: typeof typedUser.last_name === 'string' ? typedUser.last_name : null,
    languageCode: typeof typedUser.language_code === 'string' ? typedUser.language_code : null,
    isPremium: typedUser.is_premium === true,
  };

  const queryId = params.get('query_id') || null;

  return { ok: true, user, queryId, authDate };
}
