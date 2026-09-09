import { test } from 'node:test';
import assert from 'node:assert';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { TelegramAuthGuard } from './telegram-auth.guard';
import { createMockTelegramInitData } from '../../modules/auth/utils/telegram-webapp.util';

const TEST_BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567';

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

test('TelegramAuthGuard throws 401 AUTH_UNAUTHORIZED when Authorization header is missing', () => {
  const guard = new TelegramAuthGuard();
  const { context } = createMockExecutionContext({});

  assert.throws(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const response = err.getResponse();
      assert.strictEqual(response.error, 'AUTH_UNAUTHORIZED');
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
      assert.strictEqual(response.error, 'AUTH_UNAUTHORIZED');
      return true;
    }
  );
});

test('TelegramAuthGuard validates valid tma header and attaches user to request', () => {
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
    authorization: `tma ${initData}`,
  });

  const canActivate = guard.canActivate(context);
  assert.strictEqual(canActivate, true);
  assert.strictEqual(request.user.id, 11223344);
  assert.strictEqual(request.user.firstName, 'Bob');
  assert.strictEqual(request.user.username, 'bob_the_builder');
  assert.strictEqual(request.telegramQueryId, 'query_12345');
});

test('TelegramAuthGuard throws 401 AUTH_INVALID_INIT_DATA on tampered signature', () => {
  process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;
  const guard = new TelegramAuthGuard();

  const user = { id: 11223344, first_name: 'Bob' };
  const tamperedInitData = createMockTelegramInitData(user, TEST_BOT_TOKEN, {
    tampered: true,
  });

  const { context } = createMockExecutionContext({
    authorization: `TMA ${tamperedInitData}`, // Case-insensitive test
  });

  assert.throws(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const response = err.getResponse();
      assert.strictEqual(response.error, 'AUTH_INVALID_INIT_DATA');
      assert.strictEqual(response.statusCode, 401);
      return true;
    }
  );
});
