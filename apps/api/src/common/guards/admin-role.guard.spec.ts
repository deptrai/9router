import { test } from 'node:test';
import assert from 'node:assert';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { AdminRoleGuard } from './admin-role.guard';
import { UserRole } from '@repo/shared-types';

function createMockContext(user?: any): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

test('AdminRoleGuard allows user with ADMIN role', async () => {
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

test('AdminRoleGuard throws 403 ForbiddenException when request has no user', async () => {
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
  const context = createMockContext(undefined);

  await assert.rejects(
    () => guard.canActivate(context),
    (err: any) => {
      assert.ok(err instanceof ForbiddenException);
      return true;
    },
  );
});
