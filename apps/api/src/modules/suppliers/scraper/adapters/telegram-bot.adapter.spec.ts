import { test } from 'node:test';
import assert from 'node:assert';
import { TelegramBotAdapter, BOT_USERNAME_RE } from './telegram-bot.adapter';
import { SupplierTerminalError } from './supplier-adapter';

test('[P0] BOT_USERNAME_RE validates telegram bot usernames properly', () => {
  assert.strictEqual(BOT_USERNAME_RE.test('valid_bot'), true);
  assert.strictEqual(BOT_USERNAME_RE.test('a1234'), true);
  assert.strictEqual(BOT_USERNAME_RE.test('Supplier123_Bot'), true);

  // Rejections
  assert.strictEqual(BOT_USERNAME_RE.test('+84901234567'), false);
  assert.strictEqual(BOT_USERNAME_RE.test('me'), false);
  assert.strictEqual(BOT_USERNAME_RE.test('t.me/xyz'), false);
  assert.strictEqual(BOT_USERNAME_RE.test('1234bot'), false); // starts with digit
  assert.strictEqual(BOT_USERNAME_RE.test('bot'), false); // length < 5
  assert.strictEqual(BOT_USERNAME_RE.test('a'.repeat(33)), false); // length > 32
});

test('[P0] TelegramBotAdapter.purchase() always throws SupplierTerminalError("MANUAL_FULFILL_REQUIRED")', async () => {
  const adapter = new TelegramBotAdapter();
  await assert.rejects(
    async () => adapter.purchase({} as any, {} as any),
    (err: any) => {
      assert(err instanceof SupplierTerminalError);
      assert.strictEqual(err.message, 'MANUAL_FULFILL_REQUIRED');
      return true;
    }
  );
});

test('[P1] TelegramBotAdapter.validate() fails closed on invalid or missing configs', () => {
  const adapter = new TelegramBotAdapter();
  const origEnvUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origEnvToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;

  try {
    delete process.env.TELEGRAM_SCRAPER_RELAY_URL;
    delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;

    // Non-object
    assert.deepStrictEqual(adapter.validate(null), { ok: false, reason: 'configCredentials must be an object' });
    assert.deepStrictEqual(adapter.validate('string'), { ok: false, reason: 'configCredentials must be an object' });

    // Missing botUsername
    assert.strictEqual(adapter.validate({}).ok, false);
    assert.strictEqual(adapter.validate({}).reason, 'botUsername is required');

    // Invalid botUsername
    assert.strictEqual(adapter.validate({ botUsername: '+84901234567' }).ok, false);
    assert.strictEqual(adapter.validate({ botUsername: 'me' }).ok, false);
    assert.strictEqual(adapter.validate({ botUsername: 't.me/mybot' }).ok, false);

    // Missing or invalid vndPerCredit
    assert.strictEqual(adapter.validate({ botUsername: 'valid_bot' }).ok, false);
    assert.strictEqual(adapter.validate({ botUsername: 'valid_bot', vndPerCredit: 0 }).ok, false);
    assert.strictEqual(adapter.validate({ botUsername: 'valid_bot', vndPerCredit: -100 }).ok, false);
    assert.strictEqual(adapter.validate({ botUsername: 'valid_bot', vndPerCredit: 'abc' }).ok, false);

    // Missing command and interactionSteps
    assert.strictEqual(adapter.validate({ botUsername: 'valid_bot', vndPerCredit: 1000 }).ok, false);
    assert.strictEqual(
      adapter.validate({ botUsername: 'valid_bot', vndPerCredit: 1000 }).reason,
      'command or interactionSteps is required'
    );

    // Missing env relayUrl / relayToken
    const validBaseConfig = {
      botUsername: 'valid_bot',
      vndPerCredit: 1000,
      command: '/start',
    };
    assert.strictEqual(adapter.validate(validBaseConfig).ok, false);
    assert.strictEqual(
      adapter.validate(validBaseConfig).reason,
      'TELEGRAM_SCRAPER_RELAY_URL environment variable is required'
    );

    // Add relayUrl only
    process.env.TELEGRAM_SCRAPER_RELAY_URL = 'http://relay:3800';
    assert.strictEqual(adapter.validate(validBaseConfig).ok, false);
    assert.strictEqual(
      adapter.validate(validBaseConfig).reason,
      'TELEGRAM_SCRAPER_RELAY_TOKEN environment variable is required'
    );

    // Add relayToken
    process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = 'secret-token';

    // Now validBaseConfig should pass
    const validResult = adapter.validate(validBaseConfig);
    assert.strictEqual(validResult.ok, true);

    // Supports @ prefix in username
    assert.strictEqual(adapter.validate({ ...validBaseConfig, botUsername: '@valid_bot' }).ok, true);

    // syncIntervalSec < 3600
    assert.strictEqual(
      adapter.validate({ ...validBaseConfig, syncIntervalSec: 1800 }).ok,
      false
    );
    assert.strictEqual(
      adapter.validate({ ...validBaseConfig, syncIntervalSec: 1800 }).reason,
      'syncIntervalSec must be >= 3600'
    );

    // syncIntervalSec >= 3600 is valid
    assert.strictEqual(
      adapter.validate({ ...validBaseConfig, syncIntervalSec: 3600 }).ok,
      true
    );
    assert.strictEqual(
      adapter.validate({ ...validBaseConfig, syncIntervalSec: 7200 }).ok,
      true
    );

    // relayUrl / relayToken inside configCredentials must be rejected explicitly (security test)
    assert.strictEqual(
      adapter.validate({ ...validBaseConfig, relayUrl: 'http://malicious-site.com' }).ok,
      false
    );
    assert.ok(
      adapter.validate({ ...validBaseConfig, relayUrl: 'http://malicious-site.com' }).reason?.includes('relayUrl and relayToken must not be stored in configCredentials')
    );
    assert.strictEqual(
      adapter.validate({ ...validBaseConfig, relayToken: 'stolen-token' }).ok,
      false
    );

    // Invalid protocol in TELEGRAM_SCRAPER_RELAY_URL must be rejected
    process.env.TELEGRAM_SCRAPER_RELAY_URL = 'ftp://relay:3800';
    assert.strictEqual(adapter.validate(validBaseConfig).ok, false);
    assert.ok(adapter.validate(validBaseConfig).reason?.includes('http: or https:'));
    process.env.TELEGRAM_SCRAPER_RELAY_URL = 'http://relay:3800';
  } finally {
    if (origEnvUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origEnvUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;

    if (origEnvToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origEnvToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});

test('[P1] TelegramBotAdapter.validate() checks interactionSteps validation from relay spec', () => {
  const adapter = new TelegramBotAdapter();
  const origEnvUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origEnvToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;

  try {
    process.env.TELEGRAM_SCRAPER_RELAY_URL = 'http://relay:3800';
    process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = 'secret-token';

    // Step with invalid action
    const invalidAction = adapter.validate({
      botUsername: 'valid_bot',
      vndPerCredit: 1000,
      interactionSteps: [{ action: 'jump', text: 'test' }],
    });
    assert.strictEqual(invalidAction.ok, false);
    assert.ok(invalidAction.reason?.includes('steps[0].action must be send or press'));

    // Step with payment keyword blocked
    const blockedKeyword = adapter.validate({
      botUsername: 'valid_bot',
      vndPerCredit: 1000,
      interactionSteps: [{ action: 'press', text: 'Mua ngay' }],
    });
    assert.strictEqual(blockedKeyword.ok, false);
    assert.ok(blockedKeyword.reason?.includes('blocked payment keyword'));

    // Valid steps
    const validSteps = adapter.validate({
      botUsername: 'valid_bot',
      vndPerCredit: 1000,
      interactionSteps: [{ action: 'send', text: '/catalog' }],
    });
    assert.strictEqual(validSteps.ok, true);
  } finally {
    if (origEnvUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origEnvUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;

    if (origEnvToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origEnvToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});

test('[P1] TelegramBotAdapter.fetchCatalog() calls relay with expected payload and auth header', async () => {
  const adapter = new TelegramBotAdapter();
  const origEnvUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origEnvToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  const origFetch = globalThis.fetch;

  try {
    process.env.TELEGRAM_SCRAPER_RELAY_URL = 'http://relay-mock:3800';
    process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = 'secret-auth-token-123';

    let capturedUrl = '';
    let capturedOptions: any = null;

    globalThis.fetch = (async (url: string, opts: any) => {
      capturedUrl = url;
      capturedOptions = opts;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          messages: ['1. Item 1\n💵 50k'],
        }),
      };
    }) as any;

    const result = await adapter.fetchCatalog({
      botUsername: '@supplier_bot',
      vndPerCredit: 1000,
      command: '/products',
    });

    assert.strictEqual(capturedUrl, 'http://relay-mock:3800/relay');
    assert.strictEqual(capturedOptions.method, 'POST');
    assert.strictEqual(capturedOptions.headers['Content-Type'], 'application/json');
    assert.strictEqual(capturedOptions.headers['Authorization'], 'Bearer secret-auth-token-123');

    const body = JSON.parse(capturedOptions.body);
    assert.strictEqual(body.botUsername, 'supplier_bot');
    assert.strictEqual(body.command, '/products');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.messages?.length, 1);

    // Relay returns HTTP 500
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Relay Error',
    })) as any;

    await assert.rejects(
      async () =>
        adapter.fetchCatalog({
          botUsername: '@supplier_bot',
          vndPerCredit: 1000,
          command: '/products',
        }),
      /Relay HTTP 500: Internal Relay Error/
    );

    // Relay returns HTTP 200 with { ok: false, error: 'Session expired' }
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        error: 'Session expired',
      }),
    })) as any;

    await assert.rejects(
      async () =>
        adapter.fetchCatalog({
          botUsername: '@supplier_bot',
          vndPerCredit: 1000,
          command: '/products',
        }),
      /Session expired/
    );
  } finally {
    globalThis.fetch = origFetch;
    if (origEnvUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origEnvUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;

    if (origEnvToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origEnvToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});

test('[P1] TelegramBotAdapter.fetchCatalog() normalizes relay URL correctly with trailing slashes and existing /relay suffix', async () => {
  const adapter = new TelegramBotAdapter();
  const origEnvUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origEnvToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  const origFetch = globalThis.fetch;

  try {
    process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = 'token-xyz';

    const testCases = [
      { input: 'http://relay:3800', expected: 'http://relay:3800/relay' },
      { input: 'http://relay:3800/', expected: 'http://relay:3800/relay' },
      { input: 'http://relay:3800///', expected: 'http://relay:3800/relay' },
      { input: 'http://relay:3800/relay', expected: 'http://relay:3800/relay' },
      { input: 'http://relay:3800/relay/', expected: 'http://relay:3800/relay' },
      { input: 'http://relay:3800/relay///', expected: 'http://relay:3800/relay' },
    ];

    for (const tc of testCases) {
      process.env.TELEGRAM_SCRAPER_RELAY_URL = tc.input;
      let capturedUrl = '';
      globalThis.fetch = (async (url: string) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, messages: ['1. Test\n💵 50k'] }),
        };
      }) as any;

      await adapter.fetchCatalog({
        botUsername: 'test_bot',
        vndPerCredit: 1000,
        command: '/catalog',
      });

      assert.strictEqual(capturedUrl, tc.expected, `Failed for input: ${tc.input}`);
    }
  } finally {
    globalThis.fetch = origFetch;
    if (origEnvUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origEnvUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;

    if (origEnvToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origEnvToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});
