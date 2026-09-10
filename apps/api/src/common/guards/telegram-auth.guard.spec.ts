import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { ExecutionContext, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { TelegramAuthGuard } from './telegram-auth.guard';
import { createMockTelegramInitData } from '../../modules/auth/utils/__fixtures__/telegram-init-data';

const TEST_BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567';
let previousTelegramBotToken: string | undefined;

function createMockExecutionContext(headers: Record<string, string>): {
  context: ExecutionContext;
  request: any;
} {
  const request: any = { headers };
  const context: any = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  };
  return { context, request };
}

function createExecutionContextWithRequest(request: any): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as any;
}

beforeEach(() => {
  previousTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
});

afterEach(() => {
  if (previousTelegramBotToken === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = previousTelegramBotToken;
  }
});

test('TelegramAuthGuard throws 401 AUTH_UNAUTHORIZED when Authorization header is missing', () => {
  const guard = new TelegramAuthGuard();
  const { context } = createMockExecutionContext({});

  assert.throws(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const response = err.getResponse();
      assert.strictEqual(response.errorCode, 'AUTH_UNAUTHORIZED');
      assert.strictEqual(response.statusCode, 401);
      return true;
    }
  );
});

test('TelegramAuthGuard throws 401 AUTH_UNAUTHORIZED when Authorization header does not start with tma', () => {
  const guard = new TelegramAuthGuard();
  const { context } = createMockExecutionContext({
    authorization: 'Bearer some_jwt_token',
  });

  assert.throws(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const response = err.getResponse();
      assert.strictEqual(response.errorCode, 'AUTH_UNAUTHORIZED');
      return true;
    }
  );
});

test('TelegramAuthGuard is case-insensitive and allows TMA prefix', () => {
  process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;

  const guard = new TelegramAuthGuard();
  const user = {
    id: 11223344,
    first_name: 'Bob',
    username: 'bob_the_builder',
  };
  const initData = createMockTelegramInitData(user, TEST_BOT_TOKEN, {
    queryId: 'query_12345',
  });

  const { context, request } = createMockExecutionContext({
    authorization: `TMA ${initData}`,
  });

  const canActivate = guard.canActivate(context);
  assert.strictEqual(canActivate, true);
  assert.strictEqual(request.user.id, 11223344);
  assert.strictEqual(request.user.firstName, 'Bob');
  assert.strictEqual(request.user.username, 'bob_the_builder');
  assert.strictEqual(request.telegramQueryId, 'query_12345');

  // env restored by afterEach
});

test('TelegramAuthGuard throws 401 AUTH_UNAUTHORIZED on tampered signature', () => {
  process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;

  const guard = new TelegramAuthGuard();
  const user = { id: 11223344, first_name: 'Bob' };
  const tamperedInitData = createMockTelegramInitData(user, TEST_BOT_TOKEN, {
    tampered: true,
  });

  const { context } = createMockExecutionContext({
    authorization: `tma ${tamperedInitData}`,
  });

  assert.throws(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const response = err.getResponse();
      assert.strictEqual(response.errorCode, 'AUTH_INVALID_INIT_DATA');
      assert.strictEqual(response.statusCode, 401);
      return true;
    }
  );

  // env restored by afterEach
});

test('TelegramAuthGuard throws 500 when TELEGRAM_BOT_TOKEN is not configured', () => {
  delete process.env.TELEGRAM_BOT_TOKEN;

  const guard = new TelegramAuthGuard();
  const { context } = createMockExecutionContext({
    authorization: 'tma some_init_data',
  });

  assert.throws(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof InternalServerErrorException);
      const response = err.getResponse();
      assert.strictEqual(response.errorCode, 'CONFIG_TELEGRAM_BOT_TOKEN_MISSING');
      assert.strictEqual(response.statusCode, 500);
      return true;
    }
  );
});

test('TelegramAuthGuard rejects bot users', () => {
  process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;

  const guard = new TelegramAuthGuard();
  const botUser = { id: 11223344, first_name: 'Bob', is_bot: true };
  const initData = createMockTelegramInitData(botUser, TEST_BOT_TOKEN);

  const { context } = createMockExecutionContext({
    authorization: `tma ${initData}`,
  });

  assert.throws(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const response = err.getResponse();
      assert.strictEqual(response.errorCode, 'AUTH_INVALID_INIT_DATA');
      return true;
    }
  );

  // env restored by afterEach
});

test('TelegramAuthGuard trims leading and trailing spaces around the initData token', () => {
  process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;

  const guard = new TelegramAuthGuard();
  const user = { id: 11223344, first_name: 'Bob' };
  const initData = createMockTelegramInitData(user, TEST_BOT_TOKEN);

  const { context, request } = createMockExecutionContext({
    authorization: `tma  ${initData}  `,
  });

  assert.strictEqual(guard.canActivate(context), true);
  assert.strictEqual(request.user.id, 11223344);

  // env restored by afterEach
});
