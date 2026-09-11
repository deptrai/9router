import { test } from 'node:test';
import assert from 'node:assert';
import { PriceSyncService } from './price-sync.service';
import { PriceSyncAction, AdminAlertType, ProductSourcingMode } from '@repo/shared-types';
import { RedisUnavailableError } from '../../common/redis/redis.service';

function createMockDeps() {
  const mockRedis = {
    withLock: async (_key: string, _ttl: number, fn: any) => fn(),
  };

  const fetcherCalls: any[] = [];
  const mockFetcher = {
    fetchUpstreamCost: async (product: any, _supplier: any) => {
      fetcherCalls.push(product.slug);
      if (product.slug === 'fail-item') {
        throw new Error('PRICE_FETCH_FAILED: upstream timeout');
      }
      if (product.mockCost) {
        return product.mockCost;
      }
      return '100000.00';
    },
  };

  const alertCalls: any[] = [];
  const mockTelegram = {
    sendAdminAlert: async (text: string) => {
      alertCalls.push(text);
    },
  };

  return { mockRedis, mockFetcher, fetcherCalls, mockTelegram, alertCalls };
}

// fetcherCalls records slugs in fetch order — the last entry is the product
// currently inside syncOne's transaction, so FOR UPDATE can return its fresh row.
// freshOverrides lets a test simulate mid-run state changes (e.g. autoPricing
// flipped off between scan and write).
function createMockDb(
  rows: any[],
  fetcherCalls: any[] = [],
  freshOverrides: Record<string, any> = {},
) {
  const updates: any[] = [];
  const inserts: any[] = [];

  const tx: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => {
            const slug = fetcherCalls[fetcherCalls.length - 1];
            const row = rows.find((r) => r.product.slug === slug);
            if (!row) return Promise.resolve([]);
            const fresh = { ...row.product, ...(freshOverrides[row.product.id] ?? {}) };
            return Promise.resolve([fresh]);
          },
        }),
      }),
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: (whereClause: any) => {
          updates.push({ table, values, whereClause });
          return Promise.resolve([values]);
        },
      }),
    }),
    insert: (table: any) => ({
      values: (values: any) => {
        inserts.push({ table, values });
        return Promise.resolve([values]);
      },
    }),
  };

  const dbMock: any = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
    }),
    transaction: async (fn: any) => fn(tx),
  };

  return { dbMock, updates, inserts, tx };
}

test('PriceSyncService happy path updates external product price', async () => {
  const { mockRedis, mockFetcher, fetcherCalls, mockTelegram } = createMockDeps();
  const product = {
    id: 'prod-1',
    slug: 'spotify-1m',
    title: 'Spotify 1M',
    price: '50000.00',
    upstreamCost: '40000.00',
    maxUpstreamCost: '60000.00',
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true,
    mockCost: '45000.00',
  };
  const supplier = {
    id: 'sup-1',
    name: 'Partner A',
    markupPercentage: '20.00',
    markupFixedVnd: '10000.00',
    isActive: true,
  };

  const { dbMock, updates } = createMockDb([{ product, supplier }], fetcherCalls);
  const service = new PriceSyncService(mockRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.scanned, 1);
  assert.strictEqual(summary.updated, 1);
  assert.strictEqual(summary.items[0].action, PriceSyncAction.UPDATED);
  // Cost 45k * 1.2 + 10k = 64k -> rounded 64k = '64000.00'
  assert.strictEqual(summary.items[0].newPrice, '64000.00');
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].values.price, '64000.00');
});

test('PriceSyncService marks UNCHANGED when cost and rounded price do not change', async () => {
  const { mockRedis, mockFetcher, fetcherCalls, mockTelegram } = createMockDeps();
  const product = {
    id: 'prod-1',
    slug: 'office-365',
    title: 'Office 365',
    price: '130000.00',
    upstreamCost: '100000.00',
    maxUpstreamCost: null,
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true,
    mockCost: '100000.00', // 100k * 1.2 + 10k = 130k -> exactly current price
  };
  const supplier = {
    id: 'sup-1',
    name: 'Partner A',
    markupPercentage: '20.00',
    markupFixedVnd: '10000.00',
    isActive: true,
  };

  const { dbMock, updates } = createMockDb([{ product, supplier }], fetcherCalls);
  const service = new PriceSyncService(mockRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.unchanged, 1);
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(summary.items[0].action, PriceSyncAction.UNCHANGED);
  assert.strictEqual(updates.length, 0, 'Should not perform dirty writes when price and cost unchanged');
});

test('PriceSyncService deactivates active product and creates alert when cost exceeds max threshold', async () => {
  const { mockRedis, mockFetcher, fetcherCalls, mockTelegram, alertCalls } = createMockDeps();
  const product = {
    id: 'prod-breach',
    slug: 'netflix-breach',
    title: 'Netflix 1M',
    price: '100000.00',
    upstreamCost: '80000.00',
    maxUpstreamCost: '90000.00',
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true,
    mockCost: '120000.00', // Exceeds 90k threshold
  };
  const supplier = {
    id: 'sup-1',
    name: 'Partner A',
    markupPercentage: '20.00',
    markupFixedVnd: '0.00',
    isActive: true,
  };

  const { dbMock, updates, inserts } = createMockDb([{ product, supplier }], fetcherCalls);
  const service = new PriceSyncService(mockRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.deactivated, 1);
  assert.strictEqual(summary.items[0].action, PriceSyncAction.DEACTIVATED);
  assert.strictEqual(updates[0].values.isActive, false);
  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(inserts[0].values.type, AdminAlertType.PRICE_THRESHOLD_EXCEEDED);
  assert.strictEqual(alertCalls.length, 1);
  assert.ok(alertCalls[0].includes('120000.00'));
});

test('PriceSyncService does not duplicate alert if product is already inactive on breach', async () => {
  const { mockRedis, mockFetcher, fetcherCalls, mockTelegram, alertCalls } = createMockDeps();
  const product = {
    id: 'prod-already-inactive',
    slug: 'netflix-inactive',
    title: 'Netflix 1M',
    price: '100000.00',
    upstreamCost: '80000.00',
    maxUpstreamCost: '90000.00',
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: false, // Already inactive!
    mockCost: '130000.00',
  };
  const supplier = {
    id: 'sup-1',
    name: 'Partner A',
    markupPercentage: '20.00',
    markupFixedVnd: '0.00',
    isActive: true,
  };

  const { dbMock, inserts } = createMockDb([{ product, supplier }], fetcherCalls);
  const service = new PriceSyncService(mockRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.unchanged, 1);
  assert.strictEqual(summary.deactivated, 0);
  assert.strictEqual(inserts.length, 0, 'No alert should be created for already inactive product');
  assert.strictEqual(alertCalls.length, 0);
});

test('PriceSyncService counts FAILED and continues processing other items when fetcher throws', async () => {
  const { mockRedis, mockFetcher, fetcherCalls, mockTelegram } = createMockDeps();
  const product1 = {
    id: 'p-fail',
    slug: 'fail-item',
    title: 'Fail Item',
    price: '50000.00',
    upstreamCost: '30000.00',
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true,
  };
  const product2 = {
    id: 'p-ok',
    slug: 'ok-item',
    title: 'OK Item',
    price: '50000.00',
    upstreamCost: '30000.00',
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true,
    mockCost: '40000.00',
  };
  const supplier = {
    id: 'sup-1',
    name: 'Partner A',
    markupPercentage: '0.00',
    markupFixedVnd: '10000.00',
    isActive: true,
  };

  const { dbMock } = createMockDb(
    [
      { product: product1, supplier },
      { product: product2, supplier },
    ],
    fetcherCalls,
  );
  const service = new PriceSyncService(mockRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.scanned, 2);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.updated, 1);
  assert.strictEqual(summary.items[0].action, PriceSyncAction.FAILED);
  assert.strictEqual(summary.items[1].action, PriceSyncAction.UPDATED);
});

test('PriceSyncService skips IN_HOUSE products, autoPricing=false, inactive suppliers, and missing supplier rows', async () => {
  const { mockRedis, mockFetcher, fetcherCalls, mockTelegram } = createMockDeps();
  const rows = [
    {
      product: { id: 'p1', slug: 'in-house', sourcingMode: ProductSourcingMode.IN_HOUSE, autoPricing: true, isActive: true },
      supplier: { id: 's1', isActive: true },
    },
    {
      product: { id: 'p2', slug: 'manual-price', sourcingMode: ProductSourcingMode.EXTERNAL, autoPricing: false, isActive: true },
      supplier: { id: 's1', isActive: true },
    },
    {
      product: { id: 'p3', slug: 'inactive-sup', sourcingMode: ProductSourcingMode.EXTERNAL, autoPricing: true, isActive: true },
      supplier: { id: 's2', isActive: false },
    },
    {
      product: { id: 'p4', slug: 'orphaned-external', sourcingMode: ProductSourcingMode.EXTERNAL, autoPricing: true, isActive: true },
      supplier: null,
    },
  ];

  const { dbMock } = createMockDb(rows, fetcherCalls);
  const service = new PriceSyncService(mockRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.scanned, 4);
  assert.strictEqual(summary.skipped, 4);
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(summary.items.length, 4);
  assert.ok(summary.items.every((it) => it.action === PriceSyncAction.SKIPPED));
  assert.strictEqual(fetcherCalls.length, 0, 'Skipped products must not hit the fetcher');
});

test('PriceSyncService still marks DEACTIVATED even if sendAdminAlert throws', async () => {
  const { mockRedis, mockFetcher, fetcherCalls } = createMockDeps();
  const failingTelegram = {
    sendAdminAlert: async () => {
      throw new Error('Telegram API connection error');
    },
  };
  const product = {
    id: 'prod-breach',
    slug: 'breach-item',
    title: 'Breach Item',
    price: '100000.00',
    upstreamCost: '80000.00',
    maxUpstreamCost: '90000.00',
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true,
    mockCost: '120000.00',
  };
  const supplier = {
    id: 'sup-1',
    name: 'Partner A',
    markupPercentage: '0.00',
    markupFixedVnd: '0.00',
    isActive: true,
  };

  const { dbMock } = createMockDb([{ product, supplier }], fetcherCalls);
  const service = new PriceSyncService(mockRedis as any, mockFetcher as any, failingTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.deactivated, 1);
  assert.strictEqual(summary.items[0].action, PriceSyncAction.DEACTIVATED);
});

test('PriceSyncService skips the run entirely when lock:price-sync is held by another run', async () => {
  const { mockFetcher, fetcherCalls, mockTelegram } = createMockDeps();
  const contendedRedis = {
    withLock: async () => {
      throw Object.assign(new Error('The operation was unable to achieve a quorum'), {
        name: 'ResourceLockedError',
      });
    },
  };

  const { dbMock } = createMockDb([], fetcherCalls);
  const service = new PriceSyncService(contendedRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.scanned, 0);
  assert.strictEqual(fetcherCalls.length, 0, 'Must not run unlocked when another sync holds the lock');
});

test('PriceSyncService fails open and runs without lock when Redis is unavailable', async () => {
  const { mockFetcher, fetcherCalls, mockTelegram } = createMockDeps();
  const downRedis = {
    withLock: async () => {
      throw new RedisUnavailableError('connect ECONNREFUSED');
    },
  };
  const product = {
    id: 'p1',
    slug: 'office-365',
    title: 'Office 365',
    price: '130000.00',
    upstreamCost: '100000.00',
    maxUpstreamCost: null,
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true,
    mockCost: '100000.00',
  };
  const supplier = { id: 's1', name: 'A', markupPercentage: '20.00', markupFixedVnd: '10000.00', isActive: true };

  const { dbMock } = createMockDb([{ product, supplier }], fetcherCalls);
  const service = new PriceSyncService(downRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.scanned, 1);
  assert.strictEqual(fetcherCalls.length, 1);
});

test('PriceSyncService propagates lock errors thrown after the routine already ran (no double-processing)', async () => {
  const { mockFetcher, fetcherCalls, mockTelegram } = createMockDeps();
  const flakyRedis = {
    withLock: async (_k: string, _t: number, fn: any) => {
      await fn(); // routine runs
      throw Object.assign(new Error('lock lost during execution'), { name: 'ExecutionError' });
    },
  };
  const product = {
    id: 'p1',
    slug: 'spotify-1m',
    title: 'Spotify',
    price: '50000.00',
    upstreamCost: '40000.00',
    maxUpstreamCost: null,
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true,
    mockCost: '45000.00',
  };
  const supplier = { id: 's1', name: 'A', markupPercentage: '20.00', markupFixedVnd: '10000.00', isActive: true };

  const { dbMock } = createMockDb([{ product, supplier }], fetcherCalls);
  const service = new PriceSyncService(flakyRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  await assert.rejects(() => service.syncAll(), /lock lost/);
  assert.strictEqual(fetcherCalls.length, 1, 'Routine ran exactly once — no blind re-run');
});

test('PriceSyncService isolates transaction failures per product and continues', async () => {
  const { mockRedis, mockFetcher, fetcherCalls, mockTelegram } = createMockDeps();
  const product1 = {
    id: 'p-tx-fail',
    slug: 'tx-fail-item',
    title: 'Tx Fail',
    price: '50000.00',
    upstreamCost: '30000.00',
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true,
    mockCost: '40000.00',
  };
  const product2 = {
    id: 'p-ok',
    slug: 'ok-item',
    title: 'OK',
    price: '50000.00',
    upstreamCost: '30000.00',
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true,
    mockCost: '40000.00',
  };
  const supplier = { id: 's1', name: 'A', markupPercentage: '0.00', markupFixedVnd: '10000.00', isActive: true };

  const { dbMock } = createMockDb(
    [
      { product: product1, supplier },
      { product: product2, supplier },
    ],
    fetcherCalls,
  );
  let txCount = 0;
  const origTx = dbMock.transaction;
  dbMock.transaction = async (fn: any) => {
    txCount++;
    if (txCount === 1) throw new Error('deadlock detected');
    return origTx(fn);
  };
  const service = new PriceSyncService(mockRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.scanned, 2);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.updated, 1);
  assert.strictEqual(summary.items[0].action, PriceSyncAction.FAILED);
  assert.strictEqual(summary.items[1].action, PriceSyncAction.UPDATED);
});

test('PriceSyncService skips when autoPricing is flipped off between scan and write', async () => {
  const { mockRedis, mockFetcher, fetcherCalls, mockTelegram } = createMockDeps();
  const product = {
    id: 'p-flip',
    slug: 'flip-item',
    title: 'Flip',
    price: '50000.00',
    upstreamCost: '30000.00',
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true, // snapshot says on...
    isActive: true,
    mockCost: '40000.00',
  };
  const supplier = { id: 's1', name: 'A', markupPercentage: '0.00', markupFixedVnd: '10000.00', isActive: true };

  const { dbMock, updates } = createMockDb(
    [{ product, supplier }],
    fetcherCalls,
    { 'p-flip': { autoPricing: false } }, // ...but flipped off before the lock
  );
  const service = new PriceSyncService(mockRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(updates.length, 0);
});

test('PriceSyncService does not deactivate or alert when product was already deactivated mid-run', async () => {
  const { mockRedis, mockFetcher, fetcherCalls, mockTelegram, alertCalls } = createMockDeps();
  const product = {
    id: 'p-mid-deact',
    slug: 'mid-deact',
    title: 'Mid Deact',
    price: '100000.00',
    upstreamCost: '80000.00',
    maxUpstreamCost: '90000.00',
    sourcingMode: ProductSourcingMode.EXTERNAL,
    autoPricing: true,
    isActive: true, // snapshot says active...
    mockCost: '120000.00',
  };
  const supplier = { id: 's1', name: 'A', markupPercentage: '0.00', markupFixedVnd: '0.00', isActive: true };

  const { dbMock, inserts } = createMockDb(
    [{ product, supplier }],
    fetcherCalls,
    { 'p-mid-deact': { isActive: false } }, // ...but deactivated before our lock
  );
  const service = new PriceSyncService(mockRedis as any, mockFetcher as any, mockTelegram as any, dbMock as any);

  const summary = await service.syncAll();
  assert.strictEqual(summary.deactivated, 0);
  assert.strictEqual(summary.unchanged, 1);
  assert.strictEqual(inserts.length, 0, 'No duplicate alert for mid-run deactivation');
  assert.strictEqual(alertCalls.length, 0);
});
