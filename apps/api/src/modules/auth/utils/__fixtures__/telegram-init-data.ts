import crypto from 'node:crypto';

export interface MockTelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_bot?: boolean;
  is_premium?: boolean;
}

export interface MockTelegramInitDataOptions {
  authDate?: number | null;
  queryId?: string;
  tampered?: boolean;
  extraParams?: Record<string, string>;
}

/**
 * Test fixture: creates a signed Telegram initData query string.
 */
export function createMockTelegramInitData(
  user: MockTelegramUser,
  botToken: string,
  options: MockTelegramInitDataOptions = {}
): string {
  const params = new URLSearchParams();

  if (options.authDate !== null) {
    const authDate = options.authDate ?? Math.floor(Date.now() / 1000);
    params.set('auth_date', String(authDate));
  }
  if (options.queryId) {
    params.set('query_id', options.queryId);
  }
  if (options.extraParams) {
    for (const [k, v] of Object.entries(options.extraParams)) {
      params.set(k, v);
    }
  }
  params.set('user', JSON.stringify(user));

  const pairs: [string, string][] = [];
  for (const [key, value] of params.entries()) {
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  let hash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (options.tampered) {
    const lastChar = hash[hash.length - 1];
    const tamperedChar = lastChar === 'a' ? 'b' : 'a';
    hash = hash.slice(0, -1) + tamperedChar;
  }

  params.set('hash', hash);
  return params.toString();
}
