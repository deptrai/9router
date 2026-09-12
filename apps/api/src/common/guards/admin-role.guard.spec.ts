import { test } from 'node:test';
import assert from 'node:assert';
import { ForbiddenException, UnauthorizedException, ExecutionContext } from '@nestjs/common';
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

test('AdminRoleGuard throws 401 when ADMIN_API_KEY is not configured or < 32 chars', async () => {
  const origKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = 'short-key-16char'; // < 32 chars

  try {
    const guard = new AdminRoleGuard({} as any);
    const context = createMockContext(undefined, { 'x-admin-key': 'short-key-16char' });

    await assert.rejects(
      () => guard.canActivate(context),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedException);
        const res = err.getResponse() as any;
        assert.strictEqual(res.errorCode, 'AUTH_INVALID_ADMIN_KEY');
        assert.match(res.message, /min 32 chars/i);
        return true;
      },
    );
  } finally {
    if (origKey !== undefined) process.env.ADMIN_API_KEY = origKey;
    else delete process.env.ADMIN_API_KEY;
  }
});
