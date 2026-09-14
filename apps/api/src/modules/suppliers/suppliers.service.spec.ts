import { test } from 'node:test';
import assert from 'node:assert';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SuppliersService } from './suppliers.service';

test('[P0] SuppliersService: listSuppliers returns mapped DTOs with linkedProductsCount', async () => {
  const mockDb: any = {
    select: () => ({
      from: (table: any) => {
        const name = table?.[Symbol.for('drizzle:Name')] ?? '';
        if (name === 'supplier_sources') {
          return {
            orderBy: () => ({
              limit: () => ({
                offset: () => ({
                  $dynamic: () => Promise.resolve([
                    {
                      id: 'sup-1',
                      name: 'Supplier 1',
                      type: 'CONFIG_POOL',
                      targetUrl: null,
                      configCredentials: { pool: [] },
                      markupPercentage: '10.00',
                      markupFixedVnd: '5000.00',
                      isActive: true,
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    },
                  ]),
                }),
              }),
            }),
          };
        }
        // products table for linked counts
        return {
          where: () => ({
            groupBy: async () => [{ supplierSourceId: 'sup-1', count: 4 }],
          }),
        };
      },
    }),
  };

  const service = new SuppliersService();
  const list = await service.listSuppliers({}, mockDb);

  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'sup-1');
  assert.strictEqual(list[0].linkedProductsCount, 4);
});

test('[P1] SuppliersService: deleteSupplier throws ConflictException if supplier has active linked products', async () => {
  let selectCall = 0;
  const mockDb: any = {
    select: () => ({
      from: () => ({
        where: (condition: any) => {
          selectCall++;
          if (selectCall === 1) {
            // First call: find supplier by id with .limit(1)
            return {
              limit: async () => [{ id: 'sup-active', isActive: true }],
            };
          }
          // Second call: count active products (array directly returned)
          return Promise.resolve([{ count: 2 }]);
        },
      }),
    }),
  };

  const service = new SuppliersService();
  await assert.rejects(
    async () => service.deleteSupplier('sup-active', mockDb),
    (err: any) => {
      assert(err instanceof ConflictException);
      assert.strictEqual(err.getResponse()?.errorCode, 'SUPPLIER_HAS_LINKED_PRODUCTS');
      return true;
    },
  );
});

test('[P1] SuppliersService: deleteSupplier deactivates supplier when no active products linked', async () => {
  let selectCall = 0;
  let updatedActive = false;

  const mockDb: any = {
    select: () => ({
      from: () => ({
        where: () => {
          selectCall++;
          if (selectCall === 1) {
            return {
              limit: async () => [{ id: 'sup-safe', isActive: true }],
            };
          }
          return Promise.resolve([{ count: 0 }]);
        },
      }),
    }),
    update: () => ({
      set: (payload: any) => {
        if (payload.isActive === false) updatedActive = true;
        return {
          where: async () => {},
        };
      },
    }),
  };

  const service = new SuppliersService();
  await service.deleteSupplier('sup-safe', mockDb);
  assert.strictEqual(updatedActive, true);
});

test('[P1] SuppliersService: updateSupplier rejects deactivation when active products linked', async () => {
  let selectCall = 0;
  const mockDb: any = {
    select: () => ({
      from: (table: any) => {
        const name = table?.[Symbol.for('drizzle:Name')] ?? '';
        return {
          where: () => {
            selectCall++;
            if (name === 'supplier_sources') {
              return {
                limit: () => Promise.resolve([{ id: 'sup-act', isActive: true, name: 'Active Sup' }]),
              };
            }
            if (name === 'products') {
              return Promise.resolve([{ count: 3 }]);
            }
            return Promise.resolve([]);
          },
        };
      },
    }),
  };

  const service = new SuppliersService();
  await assert.rejects(
    async () => service.updateSupplier('sup-act', { isActive: false }, mockDb),
    (err: any) => {
      assert.strictEqual(err.status ?? err.statusCode, 409);
      assert.strictEqual(err.response?.errorCode ?? err.getResponse?.()?.errorCode, 'SUPPLIER_HAS_LINKED_PRODUCTS');
      return true;
    },
  );
});

test('[P1] SuppliersService: updateSupplier allows deactivation when no active products linked', async () => {
  let selectCall = 0;
  const mockDb: any = {
    select: () => ({
      from: (table: any) => {
        const name = table?.[Symbol.for('drizzle:Name')] ?? '';
        return {
          where: () => {
            selectCall++;
            if (name === 'supplier_sources') {
              return {
                limit: () => Promise.resolve([{ id: 'sup-safe', isActive: true, name: 'Safe Sup' }]),
              };
            }
            if (name === 'products') {
              return Promise.resolve([{ count: 0 }]);
            }
            return Promise.resolve([]);
          },
        };
      },
    }),
    update: () => ({
      set: (vals: any) => ({
        where: () => ({
          returning: () => Promise.resolve([{
            id: 'sup-safe',
            name: 'Safe Sup',
            type: 'CONFIG_POOL',
            targetUrl: null,
            configCredentials: null,
            markupPercentage: '10.00',
            markupFixedVnd: '5000.00',
            isActive: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          }]),
        }),
      }),
    }),
  };

  const service = new SuppliersService();
  const result = await service.updateSupplier('sup-safe', { isActive: false }, mockDb);
  assert.strictEqual(result.isActive, false);
});

test('[P0] SuppliersService: createSupplier with type=TELEGRAM_BOT rejects invalid config with BadRequestException', async () => {
  const mockAdapter: any = {
    validate: (config: any) => {
      if (!config?.botUsername) return { ok: false, reason: 'botUsername is required' };
      return { ok: true };
    },
  };

  const service = new SuppliersService(mockAdapter);

  await assert.rejects(
    async () =>
      service.createSupplier({
        name: 'Telegram Bot Supplier',
        type: 'TELEGRAM_BOT',
        configCredentials: {},
      }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      const resp = err.getResponse();
      assert.strictEqual(resp.errorCode, 'INVALID_SUPPLIER_CONFIG');
      assert.strictEqual(resp.message, 'botUsername is required');
      return true;
    }
  );
});

test('[P0] SuppliersService: createSupplier with type=TELEGRAM_BOT accepts valid config', async () => {
  const mockAdapter: any = {
    validate: (config: any) => ({ ok: true }),
  };

  const mockDb: any = {
    insert: () => ({
      values: (vals: any) => ({
        returning: () =>
          Promise.resolve([
            {
              id: 'sup-tg-1',
              name: vals.name,
              type: vals.type,
              targetUrl: vals.targetUrl,
              configCredentials: vals.configCredentials,
              markupPercentage: vals.markupPercentage,
              markupFixedVnd: vals.markupFixedVnd,
              isActive: vals.isActive,
              syncIntervalSec: vals.syncIntervalSec,
              lastSyncAt: null,
              lastSyncError: null,
              consecutiveSyncFailures: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
      }),
    }),
  };

  const service = new SuppliersService(mockAdapter);
  const result = await service.createSupplier(
    {
      name: 'Telegram Bot Supplier',
      type: 'TELEGRAM_BOT',
      configCredentials: {
        botUsername: 'valid_bot',
        vndPerCredit: 1000,
        command: '/products',
      },
    },
    mockDb
  );

  assert.strictEqual(result.id, 'sup-tg-1');
  assert.strictEqual(result.type, 'TELEGRAM_BOT');
  assert.strictEqual(result.syncIntervalSec, 3600);
});

test('[P0] SuppliersService: updateSupplier with type=TELEGRAM_BOT validates config', async () => {
  const mockAdapter: any = {
    validate: (config: any) => {
      if (config?.syncIntervalSec && config.syncIntervalSec < 3600) {
        return { ok: false, reason: 'syncIntervalSec must be >= 3600' };
      }
      return { ok: true };
    },
  };

  const mockDb: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                id: 'sup-tg-1',
                name: 'TG Sup',
                type: 'TELEGRAM_BOT',
                configCredentials: { botUsername: 'my_bot' },
                isActive: true,
              },
            ]),
        }),
      }),
    }),
  };

  const service = new SuppliersService(mockAdapter);

  await assert.rejects(
    async () =>
      service.updateSupplier(
        'sup-tg-1',
        {
          configCredentials: { botUsername: 'my_bot', syncIntervalSec: 1800 },
        },
        mockDb
      ),
    (err: any) => {
      assert(err instanceof BadRequestException);
      const resp = err.getResponse();
      assert.strictEqual(resp.errorCode, 'INVALID_SUPPLIER_CONFIG');
      assert.strictEqual(resp.message, 'syncIntervalSec must be >= 3600');
      return true;
    }
  );

  // Reject top-level syncIntervalSec < 3600
  await assert.rejects(
    async () =>
      service.updateSupplier(
        'sup-tg-1',
        {
          syncIntervalSec: 1800,
        },
        mockDb
      ),
    (err: any) => {
      assert(err instanceof BadRequestException);
      const resp = err.getResponse();
      assert.strictEqual(resp.errorCode, 'INVALID_SUPPLIER_PAYLOAD');
      assert.ok(resp.message?.includes('syncIntervalSec must be an integer >= 3600'));
      return true;
    }
  );
});

test('[P0] SuppliersService: createSupplier rejects root-level syncIntervalSec < 3600', async () => {
  const mockAdapter: any = {
    validate: () => ({ ok: true }),
  };
  const service = new SuppliersService(mockAdapter);

  await assert.rejects(
    async () =>
      service.createSupplier({
        name: 'Invalid Interval Supplier',
        type: 'TELEGRAM_BOT',
        syncIntervalSec: 1200,
        configCredentials: { botUsername: 'bot', vndPerCredit: 1000, command: '/catalog' },
      }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      const resp = err.getResponse();
      assert.strictEqual(resp.errorCode, 'INVALID_SUPPLIER_PAYLOAD');
      assert.ok(resp.message?.includes('syncIntervalSec must be an integer >= 3600'));
      return true;
    }
  );
});
