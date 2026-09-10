import { test } from 'node:test';
import assert from 'node:assert';
import { UsersService } from './users.service';
import { InternalServerErrorException } from '@nestjs/common';
import type { TelegramUserDto } from '@repo/shared-types';
import type { DbOrTx } from '@repo/database';

const dto: TelegramUserDto = {
  id: 987654321,
  username: 'johndoe',
  firstName: 'John',
  lastName: 'Doe',
  languageCode: 'vi',
  isPremium: true,
};

const dtoNoOptional: TelegramUserDto = {
  id: 987654322,
  firstName: 'Jane',
};

const userRecord = {
  id: 'uuid-123',
  telegramId: 987654321,
  username: 'johndoe',
  firstName: 'John',
  lastName: 'Doe',
  languageCode: 'vi',
  isPremium: true,
  role: 'CUSTOMER',
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
  updatedAt: new Date('2026-09-10T10:00:00.000Z'),
};

function createMockTx(overrides: {
  returning?: any[];
  conflictReturning?: any[];
} = {}): DbOrTx {
  const returning = overrides.returning ?? [userRecord];
  return {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => returning,
        }),
      }),
    }),
  } as any;
}

test('UsersService.upsertByTelegram returns user from atomic upsert', async () => {
  const tx = createMockTx({ returning: [userRecord] });
  const service = new UsersService();
  const result = await service.upsertByTelegram(dto, tx);
  assert.deepStrictEqual(result, userRecord);
});

test('UsersService.upsertByTelegram truncates long language_code to 35 chars', async () => {
  const longCode = 'sr-Latn-RS-x-private-extension-extra-long';
  const tx = {
    insert: () => ({
      values: (v: any) => ({
        onConflictDoUpdate: () => ({
          returning: () => [{ ...userRecord, languageCode: v.languageCode }],
        }),
      }),
    }),
  } as any;

  const service = new UsersService();
  const result = await service.upsertByTelegram({ ...dto, languageCode: longCode }, tx);
  assert.strictEqual(result.languageCode!.length, 35);
  assert.ok(longCode.startsWith(result.languageCode as string));
});

test('UsersService.upsertByTelegram throws InternalServerErrorException when upsert fails', async () => {
  const tx = createMockTx({ returning: [] });
  const service = new UsersService();
  await assert.rejects(
    () => service.upsertByTelegram(dto, tx),
    (err: any) =>
      err instanceof InternalServerErrorException &&
      err.getResponse &&
      (err.getResponse() as any).errorCode === 'USER_UPSERT_FAILED',
  );
});

test('UsersService.upsertByTelegram handles null/undefined optional fields without update', async () => {
  let insertCalled = false;
  let values: any = null;
  const tx = {
    insert: () => ({
      values: (v: any) => {
        insertCalled = true;
        values = v;
        return {
          onConflictDoUpdate: () => ({
            returning: () => [{
              id: 'uuid-456',
              telegramId: dtoNoOptional.id,
              username: null,
              firstName: 'Jane',
              lastName: null,
              languageCode: null,
              isPremium: false,
              role: 'CUSTOMER',
              createdAt: new Date('2026-09-10T10:00:00.000Z'),
              updatedAt: new Date('2026-09-10T10:00:00.000Z'),
            }],
          }),
        };
      },
    }),
  } as any;

  const service = new UsersService();
  const result = await service.upsertByTelegram(dtoNoOptional, tx);
  assert.ok(insertCalled);
  assert.strictEqual(values.username, null);
  assert.strictEqual(values.lastName, null);
  assert.strictEqual(values.languageCode, null);
  assert.strictEqual(result.firstName, 'Jane');
});
