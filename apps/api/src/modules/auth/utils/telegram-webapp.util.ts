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

  const authDate = Number(params.get('auth_date') || '0');
  const now = Math.floor(Date.now() / 1000);

  // Reject if auth_date is older than 24 hours (86,400s) or more than 60s in the future (clock drift)
  if (!authDate || now - authDate >= 86400 || authDate > now + 60) {
    return { ok: false, error: 'initData expired' };
  }

  // Build dataCheckString by sorting all pairs alphabetically by key, excluding hash
  params.delete('hash');
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

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
  let userObj: any = null;
  if (userRaw) {
    try {
      userObj = JSON.parse(userRaw);
    } catch {
      return { ok: false, error: 'user invalid' };
    }
  }

  if (
    !userObj ||
    typeof userObj.id !== 'number' ||
    !Number.isSafeInteger(userObj.id) ||
    userObj.id <= 0
  ) {
    return { ok: false, error: 'user missing' };
  }

  if (userObj.is_bot === true) {
    return { ok: false, error: 'bot not allowed' };
  }

  const user: TelegramUserDto = {
    id: userObj.id,
    username: userObj.username || null,
    firstName: userObj.first_name || '',
    lastName: userObj.last_name || null,
    languageCode: userObj.language_code || null,
    isPremium: userObj.is_premium === true,
  };

  const queryId = params.get('query_id') || null;

  return { ok: true, user, queryId, authDate };
}

/**
 * Test fixture generator: creates a signed Telegram initData query string for testing.
 */
export function createMockTelegramInitData(
  user: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    is_bot?: boolean;
    is_premium?: boolean;
  },
  botToken: string,
  options?: {
    authDate?: number;
    queryId?: string;
    tampered?: boolean;
    extraParams?: Record<string, string>;
  }
): string {
  const authDate = options?.authDate ?? Math.floor(Date.now() / 1000);
  const params = new URLSearchParams();

  params.set('auth_date', String(authDate));
  if (options?.queryId) {
    params.set('query_id', options.queryId);
  }
  if (options?.extraParams) {
    for (const [k, v] of Object.entries(options.extraParams)) {
      params.set(k, v);
    }
  }
  params.set('user', JSON.stringify(user));

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  let hash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (options?.tampered) {
    // Invert the last character of the hash to tamper
    const lastChar = hash[hash.length - 1];
    const tamperedChar = lastChar === 'a' ? 'b' : 'a';
    hash = hash.slice(0, -1) + tamperedChar;
  }

  params.set('hash', hash);
  return params.toString();
}
