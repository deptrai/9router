import { test } from 'node:test';
import assert from 'node:assert';
import { UsersService } from './users.service';
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

function makeUserRecord(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function createMockTx(opts: {
  existing?: any[];
  inserted?: any[];
}): DbOrTx {
  let existing = opts.existing ?? [];
  let updated = false;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (n: number) => existing.slice(0, n),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => opts.inserted ?? [],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => {
          updated = true;
          return Promise.resolve();
        },
      }),
    }),
    _wasUpdated: () => updated,
    _setExisting: (next: any[]) => {
      existing = next;
    },
  } as any;
  return tx;
}

test('UsersService.upsertByTelegram creates new user when not found', async () => {
  const tx = createMockTx({ existing: [], inserted: [makeUserRecord()] });
  const service = new UsersService();
  const userId = await service.upsertByTelegram(dto, tx);
  assert.strictEqual(userId, 'uuid-123');
});

test('UsersService.upsertByTelegram updates profile when fields differ', async () => {
  const existingRecord = makeUserRecord({
    firstName: 'OldName',
    username: 'old_username',
    languageCode: 'en',
    isPremium: false,
  });
  const tx = createMockTx({ existing: [existingRecord] });
  const service = new UsersService();
  const userId = await service.upsertByTelegram(dto, tx);
  assert.strictEqual(userId, 'uuid-123');
  assert.strictEqual((tx as any)._wasUpdated(), true, 'should call update when fields differ');
});

test('UsersService.upsertByTelegram skips update when profile unchanged', async () => {
  const existingRecord = makeUserRecord();
  const tx = createMockTx({ existing: [existingRecord] });
  const service = new UsersService();
  const userId = await service.upsertByTelegram(dto, tx);
  assert.strictEqual(userId, 'uuid-123');
  assert.strictEqual((tx as any)._wasUpdated(), false, 'should NOT call update when nothing changed');
});

test('UsersService.upsertByTelegram handles race condition via fallback SELECT', async () => {
  // Simulate: insert returns empty (race: another tx inserted), fallback SELECT returns the record
  const fallbackRecord = makeUserRecord();
  let selectCallCount = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (n: number) => {
            selectCallCount++;
            // First call: empty (initial check). Second call: empty (insert returned nothing).
            // Third call (fallback): returns record
            if (selectCallCount === 1) return [];
            if (selectCallCount === 2) return [fallbackRecord];
            return [fallbackRecord];
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => [],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  } as any;

  const service = new UsersService();
  const userId = await service.upsertByTelegram(dto, tx);
  assert.strictEqual(userId, 'uuid-123', 'should return fallback record id');
});

test('UsersService.upsertByTelegram throws when fallback SELECT returns nothing', async () => {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => [],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => [],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  } as any;

  const service = new UsersService();
  await assert.rejects(
    () => service.upsertByTelegram(dto, tx),
    /Failed to upsert user for telegramId/,
  );
});
