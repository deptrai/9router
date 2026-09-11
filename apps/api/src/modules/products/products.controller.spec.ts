import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert';
import { ProductsController } from './products.controller';
import { ProductStockStatus, ProductSourcingMode } from '@repo/shared-types';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';

test('ProductsController.listCatalog returns { ok: true, products }', async () => {
  const sample = [{
    id: 'p1', title: 'Kiro', slug: 'kiro', description: null, category: 'AI',
    price: '1000.00', imageUrl: null, isActive: true,
    sourcingMode: ProductSourcingMode.IN_HOUSE, createdAt: '2026-09-11T00:00:00.000Z',
    stockStatus: ProductStockStatus.IN_STOCK, availableCount: 5,
  }];
  const service = { listCatalog: async () => sample } as any;
  const priceSync = {} as any;
  const controller = new ProductsController(service, priceSync);
  const res = await controller.listCatalog();
  assert.equal(res.ok, true);
  assert.equal(res.products.length, 1);
  assert.equal(res.products[0].stockStatus, ProductStockStatus.IN_STOCK);
});

test('POST /products/sync-prices delegates to priceSyncService and has proper guards', async () => {
  const sampleSummary = {
    scanned: 5, updated: 2, unchanged: 2, deactivated: 1, failed: 0, skipped: 0,
    items: [], startedAt: '2026-09-11T00:00:00.000Z', finishedAt: '2026-09-11T00:00:01.000Z',
  };
  let syncCalled = false;
  const mockPriceSync = {
    syncAll: async () => {
      syncCalled = true;
      return sampleSummary;
    },
  };
  const controller = new ProductsController({} as any, mockPriceSync as any);

  const res = await controller.syncPrices();
  assert.strictEqual(syncCalled, true);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.summary, sampleSummary);

  // Verify guards applied at method level
  const guards = Reflect.getMetadata('__guards__', controller.syncPrices);
  assert.ok(Array.isArray(guards));
  assert.ok(guards.includes(TelegramAuthGuard));
  assert.ok(guards.includes(AdminRoleGuard));
});
