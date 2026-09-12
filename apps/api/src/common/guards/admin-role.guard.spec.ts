import { test } from 'node:test';
import assert from 'node:assert';
import { ForbiddenException, UnauthorizedException, InternalServerErrorException, ExecutionContext } from '@nestjs/common';
import { AdminRoleGuard } from './admin-role.guard';
import { UserRole } from '@repo/shared-types';

function createMockContext(user?: any, headers: Record<string, string> = {}): ExecutionContext {
  const request = { user, headers };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

test('AdminRoleGuard allows user with ADMIN role in request.user', async () => {
  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: 'u1', telegramId: 12345, role: UserRole.ADMIN }]),
        }),
      }),
    }),
  };

  const guard = new AdminRoleGuard(mockDb as any);
  const context = createMockContext({ id: 12345, firstName: 'Admin' });

  const result = await guard.canActivate(context);
  assert.strictEqual(result, true);
});

test('AdminRoleGuard throws 403 ForbiddenException when user role is CUSTOMER', async () => {
  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: 'u2', telegramId: 67890, role: UserRole.CUSTOMER }]),
        }),
      }),
    }),
  };

  const guard = new AdminRoleGuard(mockDb as any);
  const context = createMockContext({ id: 67890, firstName: 'Customer' });

  await assert.rejects(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof ForbiddenException);
      const res = err.getResponse() as any;
      assert.strictEqual(res.errorCode, 'AUTH_FORBIDDEN_NOT_ADMIN');
      assert.strictEqual(res.statusCode, 403);
      return true;
    },
  );
});

test('AdminRoleGuard throws 403 ForbiddenException when user row is not found in database', async () => {
  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  };

  const guard = new AdminRoleGuard(mockDb as any);
  const context = createMockContext({ id: 99999, firstName: 'Ghost' });

  await assert.rejects(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof ForbiddenException);
      const res = err.getResponse() as any;
      assert.strictEqual(res.errorCode, 'AUTH_FORBIDDEN_NOT_ADMIN');
      return true;
    },
  );
});

test('AdminRoleGuard throws 401 UnauthorizedException when request has no credentials', async () => {
  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  };

  const guard = new AdminRoleGuard(mockDb as any);
  const context = createMockContext(undefined, {});

  await assert.rejects(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof UnauthorizedException);
      const res = err.getResponse() as any;
      assert.strictEqual(res.errorCode, 'AUTH_UNAUTHORIZED');
      assert.strictEqual(res.statusCode, 401);
      return true;
    },
  );
});

test('AdminRoleGuard allows access with valid x-admin-key header (min 32 chars)', async () => {
  const origKey = process.env.ADMIN_API_KEY;
  const testSecretKey = 'super-secret-admin-key-that-is-at-least-32-chars-long!';
  process.env.ADMIN_API_KEY = testSecretKey;

  try {
    const guard = new AdminRoleGuard({} as any);
    const context = createMockContext(undefined, { 'x-admin-key': testSecretKey });

    const allowed = await guard.canActivate(context);
    assert.strictEqual(allowed, true);

    const req = context.switchToHttp().getRequest() as any;
    assert.strictEqual(req.user.role, UserRole.ADMIN);
    assert.strictEqual(req.user.firstName, 'Web Admin');
  } finally {
    if (origKey !== undefined) process.env.ADMIN_API_KEY = origKey;
    else delete process.env.ADMIN_API_KEY;
  }
});

test('AdminRoleGuard throws 401 with invalid x-admin-key header', async () => {
  const origKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = 'super-secret-admin-key-that-is-at-least-32-chars-long!';

  try {
    const guard = new AdminRoleGuard({} as any);
    const context = createMockContext(undefined, { 'x-admin-key': 'wrong-key-value-123456789012345678901234567890' });

    await assert.rejects(
      () => guard.canActivate(context),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedException);
        const res = err.getResponse() as any;
        assert.strictEqual(res.errorCode, 'AUTH_INVALID_ADMIN_KEY');
        return true;
      },
    );
  } finally {
    if (origKey !== undefined) process.env.ADMIN_API_KEY = origKey;
    else delete process.env.ADMIN_API_KEY;
  }
});

test('AdminRoleGuard throws 500 when ADMIN_API_KEY is not configured or < 32 chars', async () => {
  const origKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = 'short-key-16char'; // < 32 chars

  try {
    const guard = new AdminRoleGuard({} as any);
    const context = createMockContext(undefined, { 'x-admin-key': 'short-key-16char' });

    try {
      await guard.canActivate(context);
      assert.fail('Should have thrown');
    } catch (err: any) {
      // Server misconfiguration must fail closed with 500, not 401
      assert.strictEqual(err.status, 500);
      assert.strictEqual(err.response?.errorCode, 'INTERNAL_SERVER_ERROR');
    }
  } finally {
    if (origKey !== undefined) process.env.ADMIN_API_KEY = origKey;
    else delete process.env.ADMIN_API_KEY;
  }
});

// --- Telegram WebApp tma <initData> auth flow tests ---

function buildTmaInitData(botToken: string, userId: number, firstName = 'TmaAdmin'): string {
  const crypto = require('node:crypto');
  const user = JSON.stringify({ id: userId, first_name: firstName, is_bot: false });
  const authDate = Math.floor(Date.now() / 1000).toString();
  const pairs: [string, string][] = [
    ['auth_date', authDate],
    ['query_id', 'AAE1'],
    ['user', user],
  ];
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return `auth_date=${authDate}&query_id=AAE1&user=${encodeURIComponent(user)}&hash=${hash}`;
}

test('AdminRoleGuard allows Telegram admin via Authorization: tma <initData>', async () => {
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const botToken = 'test-bot-token-1234567890abcdef';
  process.env.TELEGRAM_BOT_TOKEN = botToken;

  try {
    const initData = buildTmaInitData(botToken, 555001);
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ id: 'u-tma', telegramId: 555001, role: UserRole.ADMIN }]),
          }),
        }),
      }),
    };

    const guard = new AdminRoleGuard(mockDb as any);
    const context = createMockContext(undefined, { authorization: `tma ${initData}` });

    const allowed = await guard.canActivate(context);
    assert.strictEqual(allowed, true);

    const req = context.switchToHttp().getRequest() as any;
    assert.strictEqual(req.user.id, 555001);
    assert.strictEqual(req.user.role, UserRole.ADMIN);
  } finally {
    if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test('AdminRoleGuard throws 403 when tma user has CUSTOMER role', async () => {
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const botToken = 'test-bot-token-1234567890abcdef';
  process.env.TELEGRAM_BOT_TOKEN = botToken;

  try {
    const initData = buildTmaInitData(botToken, 555002);
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ id: 'u-cust', telegramId: 555002, role: UserRole.CUSTOMER }]),
          }),
        }),
      }),
    };

    const guard = new AdminRoleGuard(mockDb as any);
    const context = createMockContext(undefined, { authorization: `tma ${initData}` });

    await assert.rejects(
      () => guard.canActivate(context),
      (err: any) => {
        assert.ok(err instanceof ForbiddenException);
        assert.strictEqual(err.getResponse()?.errorCode, 'AUTH_FORBIDDEN_NOT_ADMIN');
        return true;
      },
    );
  } finally {
    if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test('AdminRoleGuard throws 401 when tma initData signature is invalid', async () => {
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const botToken = 'test-bot-token-1234567890abcdef';
  process.env.TELEGRAM_BOT_TOKEN = botToken;

  try {
    const mockDb = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    };

    const guard = new AdminRoleGuard(mockDb as any);
    const context = createMockContext(undefined, { authorization: 'tma invalid_data_here' });

    await assert.rejects(
      () => guard.canActivate(context),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedException);
        assert.strictEqual(err.getResponse()?.errorCode, 'AUTH_INVALID_INIT_DATA');
        return true;
      },
    );
  } finally {
    if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test('AdminRoleGuard throws 401 when TELEGRAM_BOT_TOKEN is not configured for tma', async () => {
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;

  try {
    const mockDb = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    };

    const guard = new AdminRoleGuard(mockDb as any);
    const context = createMockContext(undefined, { authorization: 'tma some_data' });

    await assert.rejects(
      () => guard.canActivate(context),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedException);
        assert.strictEqual(err.getResponse()?.errorCode, 'AUTH_UNAUTHORIZED');
        return true;
      },
    );
  } finally {
    if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
  }
});
