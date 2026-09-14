import { test } from 'node:test';
import assert from 'node:assert';
import { CatalogSyncService } from './catalog-sync.service';
import { AdminAlertType } from '@repo/shared-types';

function createMocks(options: {
  supplier?: any;
  existingProducts?: any[];
  parsedProducts?: any[];
  relayData?: any;
  relayError?: Error;
  parseError?: Error;
} = {}) {
  const {
    supplier = {
      id: 'sup-1',
      name: 'Supplier One',
      type: 'TELEGRAM_BOT',
      isActive: true,
      markupPercentage: '10.00',
      markupFixedVnd: '5000.00',
      configCredentials: {
        botUsername: 'sample_bot',
        vndPerCredit: 1000,
        command: '/catalog',
      },
      consecutiveSyncFailures: 0,
    },
    existingProducts = [],
    parsedProducts = [
      {
        supplierProductId: 'prod-sha-1',
        name: 'Product One',
        title: 'Product One Title',
        description: 'Product One Description',
        priceVnd: 50000,
        stock: 10,
        isActive: true,
      },
    ],
    relayData = { ok: true, messages: ['1. Test'] },
    relayError,
    parseError,
  } = options;

  let clearedDebounceKey = '';
  const mockRedisService = {
    getClient: () => ({
      del: async (key: string) => {
        clearedDebounceKey = key;
        return 1;
      },
    }),
  } as any;

  const mockAdapter = {
    fetchCatalog: async () => {
      if (relayError) throw relayError;
      return relayData;
    },
  } as any;

  const mockParser = {
    parse: () => {
      if (parseError) throw parseError;
      return parsedProducts;
    },
  } as any;

  const sentAdminAlerts: string[] = [];
  const mockTelegramBot = {
    sendAdminAlert: async (msg: string) => {
      sentAdminAlerts.push(msg);
    },
  } as any;

  const insertedProducts: any[] = [];
  const updatedProducts: any[] = [];
  const insertedAlerts: any[] = [];
  let supplierUpdate: any = null;

  const mockTx: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => existingProducts,
          // for slug collision checks in generateUniqueSlug:
          filter: () => [],
        }),
      }),
    }),
    insert: (_table: any) => ({
      values: async (val: any) => {
        insertedProducts.push(val);
        return [val];
      },
    }),
    update: (_table: any) => ({
      set: (val: any) => ({
        where: async () => {
          updatedProducts.push(val);
          return [val];
        },
      }),
    }),
  };

  const mockDb: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (supplier ? [supplier] : []),
        }),
      }),
    }),
    transaction: async (cb: any) => cb(mockTx),
    update: (_table: any) => ({
      set: (val: any) => ({
        where: async () => {
          supplierUpdate = val;
          return [val];
        },
      }),
    }),
    insert: (_table: any) => ({
      values: async (val: any) => {
        insertedAlerts.push(val);
        return [val];
      },
    }),
  };

  const service = new CatalogSyncService(
    mockAdapter,
    mockParser,
    mockRedisService,
    mockTelegramBot,
  );
  (service as any).db = mockDb;

  return {
    service,
    mockDb,
    mockTx,
    insertedProducts,
    updatedProducts,
    insertedAlerts,
    getSupplierUpdate: () => supplierUpdate,
    sentAdminAlerts,
    getClearedDebounceKey: () => clearedDebounceKey,
  };
}

test('[P0] CatalogSyncService: skips when supplier is not found, inactive, or not TELEGRAM_BOT', async () => {
  // Case 1: supplier not found
  const harness1 = createMocks({ supplier: null });
  const res1 = await harness1.service.syncSupplierCatalog('non-existent');
  assert.strictEqual(res1.ok, false);
  assert.strictEqual(res1.skipped, true);

  // Case 2: supplier inactive
  const harness2 = createMocks({
    supplier: { id: 'sup-inactive', isActive: false, type: 'TELEGRAM_BOT' },
  });
  const res2 = await harness2.service.syncSupplierCatalog('sup-inactive');
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.skipped, true);

  // Case 3: supplier not TELEGRAM_BOT
  const harness3 = createMocks({
    supplier: { id: 'sup-pool', isActive: true, type: 'CONFIG_POOL' },
  });
  const res3 = await harness3.service.syncSupplierCatalog('sup-pool');
  assert.strictEqual(res3.ok, false);
  assert.strictEqual(res3.skipped, true);
});

test('[P0] CatalogSyncService: INSERT creates new product with draft status, IN_HOUSE mode, and autoPricing', async () => {
  const harness = createMocks({
    existingProducts: [],
    parsedProducts: [
      {
        supplierProductId: 'sha-prod-123',
        name: 'Account Pro 1M',
        title: 'Account Pro 1M',
        description: 'Full warranty',
        priceVnd: 50000,
        stock: 5,
        isActive: true,
      },
    ],
  });

  const res = await harness.service.syncSupplierCatalog('sup-1');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.productsCount, 1);

  assert.strictEqual(harness.insertedProducts.length, 1);
  const inserted = harness.insertedProducts[0];
  assert.strictEqual(inserted.title, 'Account Pro 1M');
  assert.strictEqual(inserted.sourcingMode, 'IN_HOUSE');
  assert.strictEqual(inserted.isActive, false); // draft on insert
  assert.strictEqual(inserted.autoPricing, true);
  assert.strictEqual(inserted.supplierSourceId, 'sup-1');
  assert.strictEqual(inserted.supplierProductId, 'sha-prod-123');
  assert.strictEqual(inserted.stock, 5);
  assert.strictEqual(inserted.upstreamCost, '50000.00');
  // price = 50000 * 1.1 + 5000 = 55000 + 5000 = 60000.00
  assert.strictEqual(inserted.price, '60000.00');
  assert.ok(inserted.slug);

  const supUpdate = harness.getSupplierUpdate();
  assert.strictEqual(supUpdate.consecutiveSyncFailures, 0);
  assert.strictEqual(supUpdate.lastSyncError, null);
  assert.ok(supUpdate.lastSyncAt instanceof Date);
});

test('[P0] CatalogSyncService: UPDATE published product preserves isActive, slug, title, desc, and updates price if autoPricing', async () => {
  const existing = {
    id: 'prod-uuid-1',
    title: 'Admin Customized Title',
    slug: 'admin-customized-slug',
    description: 'Admin Customized Description',
    isActive: true,
    autoPricing: true,
    price: '99000.00',
    supplierSourceId: 'sup-1',
    supplierProductId: 'sha-prod-123',
  };

  const harness = createMocks({
    existingProducts: [existing],
    parsedProducts: [
      {
        supplierProductId: 'sha-prod-123',
        name: 'New Bot Title',
        title: 'New Bot Title',
        description: 'New Bot Description',
        priceVnd: 80000,
        stock: 20,
        isActive: true,
      },
    ],
  });

  const res = await harness.service.syncSupplierCatalog('sup-1');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(harness.insertedProducts.length, 0);
  assert.strictEqual(harness.updatedProducts.length, 1);

  const updated = harness.updatedProducts[0];
  // Invariant checks:
  assert.strictEqual(updated.isActive, undefined, 'isActive must NOT be modified');
  assert.strictEqual(updated.slug, undefined, 'slug must NOT be modified');
  assert.strictEqual(updated.title, undefined, 'title of published product must NOT be overwritten');
  assert.strictEqual(updated.description, undefined, 'desc of published product must NOT be overwritten');
  assert.strictEqual(updated.upstreamCost, '80000.00');
  assert.strictEqual(updated.stock, 20);
  // autoPricing = true -> 80000 * 1.1 + 5000 = 88000 + 5000 = 93000.00
  assert.strictEqual(updated.price, '93000.00');
});

test('[P0] CatalogSyncService: UPDATE published product with manual pricing preserves price', async () => {
  const existing = {
    id: 'prod-uuid-manual',
    title: 'Custom Title',
    slug: 'custom-slug',
    description: 'Custom Desc',
    isActive: true,
    autoPricing: false,
    price: '150000.00',
    supplierSourceId: 'sup-1',
    supplierProductId: 'sha-prod-123',
  };

  const harness = createMocks({
    existingProducts: [existing],
    parsedProducts: [
      {
        supplierProductId: 'sha-prod-123',
        name: 'Bot Title',
        title: 'Bot Title',
        description: 'Bot Desc',
        priceVnd: 50000,
        stock: 12,
        isActive: true,
      },
    ],
  });

  await harness.service.syncSupplierCatalog('sup-1');
  assert.strictEqual(harness.updatedProducts.length, 1);

  const updated = harness.updatedProducts[0];
  assert.strictEqual(updated.price, undefined, 'price must NOT be recalculated when autoPricing is false');
  assert.strictEqual(updated.upstreamCost, '50000.00');
  assert.strictEqual(updated.stock, 12);
});

test('[P1] CatalogSyncService: UPDATE draft product (isActive=false) updates title and description', async () => {
  const existing = {
    id: 'prod-uuid-draft',
    title: 'Old Draft Title',
    slug: 'old-draft-slug',
    description: 'Old Draft Description',
    isActive: false,
    autoPricing: true,
    price: '60000.00',
    supplierSourceId: 'sup-1',
    supplierProductId: 'sha-prod-123',
  };

  const harness = createMocks({
    existingProducts: [existing],
    parsedProducts: [
      {
        supplierProductId: 'sha-prod-123',
        name: 'Updated Title',
        title: 'Updated Title',
        description: 'Updated Description',
        priceVnd: 70000,
        stock: 3,
        isActive: true,
      },
    ],
  });

  await harness.service.syncSupplierCatalog('sup-1');
  assert.strictEqual(harness.updatedProducts.length, 1);

  const updated = harness.updatedProducts[0];
  assert.strictEqual(updated.title, 'Updated Title');
  assert.strictEqual(updated.description, 'Updated Description');
  assert.strictEqual(updated.isActive, undefined, 'isActive must NOT be changed');
  assert.strictEqual(updated.slug, undefined, 'slug must NOT be changed');
});

test('[P0] CatalogSyncService: deduplicates duplicate supplierProductId in batch keeping last entry', async () => {
  const harness = createMocks({
    existingProducts: [],
    parsedProducts: [
      {
        supplierProductId: 'sha-dup',
        name: 'Item First',
        title: 'Item First',
        description: 'Desc First',
        priceVnd: 50000,
        stock: 5,
        isActive: true,
      },
      {
        supplierProductId: 'sha-dup',
        name: 'Item Last',
        title: 'Item Last',
        description: 'Desc Last',
        priceVnd: 60000,
        stock: 10,
        isActive: true,
      },
    ],
  });

  const res = await harness.service.syncSupplierCatalog('sup-1');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.productsCount, 1);
  assert.strictEqual(harness.insertedProducts.length, 1);
  assert.strictEqual(harness.insertedProducts[0].title, 'Item Last');
  assert.strictEqual(harness.insertedProducts[0].stock, 10);
});

test('[P0] CatalogSyncService: zero products throws PARSER_ZERO_PRODUCTS and clears debounce', async () => {
  const harness = createMocks({
    parsedProducts: [], // empty products
  });

  await assert.rejects(
    async () => harness.service.syncSupplierCatalog('sup-1'),
    /PARSER_ZERO_PRODUCTS/
  );

  assert.strictEqual(harness.insertedProducts.length, 0);
  assert.strictEqual(harness.updatedProducts.length, 0);

  const update = harness.getSupplierUpdate();
  assert.strictEqual(update.consecutiveSyncFailures, 1);
  assert.strictEqual(update.lastSyncError, 'PARSER_ZERO_PRODUCTS');
  assert.strictEqual(harness.getClearedDebounceKey(), 'catalog-sync:debounce:sup-1');
});

test('[P0] CatalogSyncService: tracks failures 1 and 2 without sending admin alert', async () => {
  const harness = createMocks({
    supplier: {
      id: 'sup-fail',
      name: 'Failing Supplier',
      type: 'TELEGRAM_BOT',
      isActive: true,
      consecutiveSyncFailures: 1, // was 1, will become 2
    },
    relayError: new Error('Relay connection timeout (504)'),
  });

  await assert.rejects(
    async () => harness.service.syncSupplierCatalog('sup-fail'),
    /Relay connection timeout/
  );

  const update = harness.getSupplierUpdate();
  assert.strictEqual(update.consecutiveSyncFailures, 2);
  assert.strictEqual(update.lastSyncError, 'Relay connection timeout (504)');
  assert.strictEqual(harness.insertedAlerts.length, 0);
  assert.strictEqual(harness.sentAdminAlerts.length, 0);
  assert.strictEqual(harness.getClearedDebounceKey(), 'catalog-sync:debounce:sup-fail');
});

test('[P0] CatalogSyncService: alert triggers strictly on 3rd failure with NOT NULL message and schema compliance', async () => {
  const harness = createMocks({
    supplier: {
      id: 'sup-fail-3',
      name: 'Third Strike Supplier',
      type: 'TELEGRAM_BOT',
      isActive: true,
      consecutiveSyncFailures: 2, // was 2, will become 3!
    },
    relayError: new Error('MTProto connection dropped'),
  });

  await assert.rejects(
    async () => harness.service.syncSupplierCatalog('sup-fail-3'),
    /MTProto connection dropped/
  );

  const update = harness.getSupplierUpdate();
  assert.strictEqual(update.consecutiveSyncFailures, 3);

  // Admin alert verified
  assert.strictEqual(harness.insertedAlerts.length, 1);
  const alert = harness.insertedAlerts[0];
  assert.strictEqual(alert.type, AdminAlertType.CATALOG_SYNC_FAILED);
  assert.strictEqual(alert.severity, 'WARN');
  assert.strictEqual(alert.supplierSourceId, 'sup-fail-3');
  assert.ok(typeof alert.message === 'string' && alert.message.length > 0, 'message must be non-empty string');
  assert.ok(alert.message.includes('Đồng bộ danh mục thất bại 3 lần liên tiếp'));
  assert.ok(alert.message.includes('Third Strike Supplier'));
  assert.deepStrictEqual(alert.payload, {
    supplierId: 'sup-fail-3',
    consecutiveSyncFailures: 3,
    lastSyncError: 'MTProto connection dropped',
  });

  // Telegram alert verified
  assert.strictEqual(harness.sentAdminAlerts.length, 1);
  assert.strictEqual(harness.sentAdminAlerts[0], alert.message);

  // Debounce cleared
  assert.strictEqual(harness.getClearedDebounceKey(), 'catalog-sync:debounce:sup-fail-3');
});

test('[P1] CatalogSyncService: failure 4+ increments counter without duplicate alert (anti-spam)', async () => {
  const harness = createMocks({
    supplier: {
      id: 'sup-fail-4',
      name: 'Fourth Strike Supplier',
      type: 'TELEGRAM_BOT',
      isActive: true,
      consecutiveSyncFailures: 3, // was 3, will become 4!
    },
    relayError: new Error('Still failing'),
  });

  await assert.rejects(
    async () => harness.service.syncSupplierCatalog('sup-fail-4'),
    /Still failing/
  );

  const update = harness.getSupplierUpdate();
  assert.strictEqual(update.consecutiveSyncFailures, 4);
  assert.strictEqual(harness.insertedAlerts.length, 0, 'Must NOT insert alert on 4th failure');
  assert.strictEqual(harness.sentAdminAlerts.length, 0, 'Must NOT send Telegram alert on 4th failure');
  assert.strictEqual(harness.getClearedDebounceKey(), 'catalog-sync:debounce:sup-fail-4');
});
