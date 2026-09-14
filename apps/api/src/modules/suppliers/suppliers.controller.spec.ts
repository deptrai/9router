import { test } from 'node:test';
import assert from 'node:assert';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import type { SupplierSourceDto, CreateSupplierSourceDto, UpdateSupplierSourceDto } from '@repo/shared-types';

const mockSupplier: SupplierSourceDto = {
  id: 'sup-1',
  name: 'Global Key Supplier',
  type: 'CONFIG_POOL',
  targetUrl: 'https://supplier.com',
  configCredentials: { priceMap: { 'product-1': '50000.00' }, credentialPool: ['KEY-1'] },
  markupPercentage: '10.00',
  markupFixedVnd: '5000.00',
  isActive: true,
  linkedProductsCount: 3,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

test('[P0] SuppliersController: listSuppliers returns supplier list', async () => {
  const mockService: any = {
    listSuppliers: async () => [mockSupplier],
  };

  const controller = new SuppliersController(mockService);
  const result = await controller.listSuppliers();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.suppliers.length, 1);
  assert.strictEqual(result.suppliers[0].id, 'sup-1');
  assert.strictEqual(result.suppliers[0].linkedProductsCount, 3);
});

test('[P0] SuppliersController: createSupplier creates supplier and returns DTO', async () => {
  const createDto: CreateSupplierSourceDto = {
    name: 'New Scraper Supplier',
    type: 'WEB_SCRAPER',
    markupPercentage: '15.00',
    markupFixedVnd: '2000.00',
  };

  const mockService: any = {
    createSupplier: async (dto: CreateSupplierSourceDto) => {
      assert.strictEqual(dto.name, createDto.name);
      return { ...mockSupplier, id: 'sup-2', ...dto };
    },
  };

  const controller = new SuppliersController(mockService);
  const result = await controller.createSupplier(createDto);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.supplier.id, 'sup-2');
  assert.strictEqual(result.supplier.name, 'New Scraper Supplier');
});

test('[P1] SuppliersController: createSupplier rejects empty name or negative markup', async () => {
  const controller = new SuppliersController({} as any);

  await assert.rejects(
    async () => controller.createSupplier({ name: '', markupPercentage: '10.00' }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVALID_SUPPLIER_PAYLOAD');
      return true;
    },
  );

  await assert.rejects(
    async () => controller.createSupplier({ name: 'Valid', markupPercentage: '-5.00' }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVALID_SUPPLIER_PAYLOAD');
      return true;
    },
  );

  await assert.rejects(
    async () => controller.createSupplier({ name: 'Valid', markupFixedVnd: '-1000.00' }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVALID_SUPPLIER_PAYLOAD');
      return true;
    },
  );
});

test('[P0] SuppliersController: updateSupplier delegates to service', async () => {
  const updateDto: UpdateSupplierSourceDto = { markupPercentage: '20.00' };
  const mockService: any = {
    updateSupplier: async (id: string, dto: UpdateSupplierSourceDto) => {
      assert.strictEqual(id, 'sup-1');
      assert.strictEqual(dto.markupPercentage, '20.00');
      return { ...mockSupplier, markupPercentage: '20.00' };
    },
  };

  const controller = new SuppliersController(mockService);
  const result = await controller.updateSupplier('sup-1', updateDto);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.supplier.markupPercentage, '20.00');
});

test('[P1] SuppliersController: deleteSupplier rejects when supplier has active linked products', async () => {
  const mockService: any = {
    deleteSupplier: async (id: string) => {
      assert.strictEqual(id, 'sup-1');
      throw new ConflictException({
        errorCode: 'SUPPLIER_HAS_LINKED_PRODUCTS',
        message: 'Cannot delete supplier with active linked products',
      });
    },
  };

  const controller = new SuppliersController(mockService);

  await assert.rejects(
    async () => controller.deleteSupplier('sup-1'),
    (err: any) => {
      assert(err instanceof ConflictException);
      assert.strictEqual(err.getResponse()?.errorCode, 'SUPPLIER_HAS_LINKED_PRODUCTS');
      return true;
    },
  );
});

test('[P0] SuppliersController: triggerSync rejects with 404 when supplier not found', async () => {
  const mockService: any = {
    getSupplierById: async (id: string) => {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'SUPPLIER_NOT_FOUND',
        message: `Supplier ${id} not found`,
      });
    },
  };

  const controller = new SuppliersController(mockService, {} as any);

  await assert.rejects(
    async () => controller.triggerSync('550e8400-e29b-41d4-a716-446655440000'),
    (err: any) => {
      assert(err instanceof NotFoundException);
      assert.strictEqual(err.getResponse()?.errorCode, 'SUPPLIER_NOT_FOUND');
      return true;
    },
  );
});

test('[P0] SuppliersController: triggerSync rejects with 400 when supplier is not TELEGRAM_BOT', async () => {
  const mockService: any = {
    getSupplierById: async () => ({
      ...mockSupplier,
      id: 'sup-pool-1',
      type: 'CONFIG_POOL',
      isActive: true,
    }),
  };

  const controller = new SuppliersController(mockService, {} as any);

  await assert.rejects(
    async () => controller.triggerSync('550e8400-e29b-41d4-a716-446655440000'),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVALID_SUPPLIER_TYPE');
      return true;
    },
  );
});

test('[P0] SuppliersController: triggerSync rejects with 400 when supplier is inactive', async () => {
  const mockService: any = {
    getSupplierById: async () => ({
      ...mockSupplier,
      id: 'sup-tg-inactive',
      type: 'TELEGRAM_BOT',
      isActive: false,
    }),
  };

  const controller = new SuppliersController(mockService, {} as any);

  await assert.rejects(
    async () => controller.triggerSync('550e8400-e29b-41d4-a716-446655440000'),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'SUPPLIER_INACTIVE');
      return true;
    },
  );
});

test('[P0] SuppliersController: triggerSync propagates 409 ConflictException when debounced', async () => {
  const mockService: any = {
    getSupplierById: async () => ({
      ...mockSupplier,
      id: 'sup-tg-1',
      type: 'TELEGRAM_BOT',
      isActive: true,
      syncIntervalSec: 1800,
    }),
  };

  const mockQueue: any = {
    enqueueSyncJob: async (id: string, interval: number) => {
      throw new ConflictException({
        statusCode: 409,
        errorCode: 'SYNC_DEBOUNCED',
        message: `Catalog sync is currently in progress or in debounce cooldown for supplier ${id}`,
      });
    },
  };

  const controller = new SuppliersController(mockService, mockQueue);

  await assert.rejects(
    async () => controller.triggerSync('550e8400-e29b-41d4-a716-446655440000'),
    (err: any) => {
      assert(err instanceof ConflictException);
      assert.strictEqual(err.getResponse()?.errorCode, 'SYNC_DEBOUNCED');
      return true;
    },
  );
});

test('[P0] SuppliersController: triggerSync enqueues job and returns { ok: true, jobId }', async () => {
  let passedId = '';
  let passedInterval = 0;

  const mockService: any = {
    getSupplierById: async () => ({
      ...mockSupplier,
      id: 'sup-tg-1',
      type: 'TELEGRAM_BOT',
      isActive: true,
      syncIntervalSec: 1800,
    }),
  };

  const mockQueue: any = {
    enqueueSyncJob: async (id: string, interval: number) => {
      passedId = id;
      passedInterval = interval;
      return { ok: true, jobId: `sync-${id}` };
    },
  };

  const controller = new SuppliersController(mockService, mockQueue);
  const result = await controller.triggerSync('550e8400-e29b-41d4-a716-446655440000');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.jobId, 'sync-550e8400-e29b-41d4-a716-446655440000');
  assert.strictEqual(passedId, '550e8400-e29b-41d4-a716-446655440000');
  assert.strictEqual(passedInterval, 1800);
});

test('[P0] SuppliersController: getSyncStatus rejects with 404 when supplier not found', async () => {
  const mockService: any = {
    getSupplierById: async (id: string) => {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'SUPPLIER_NOT_FOUND',
        message: `Supplier ${id} not found`,
      });
    },
  };

  const controller = new SuppliersController(mockService, {} as any);

  await assert.rejects(
    async () => controller.getSyncStatus('550e8400-e29b-41d4-a716-446655440000'),
    (err: any) => {
      assert(err instanceof NotFoundException);
      assert.strictEqual(err.getResponse()?.errorCode, 'SUPPLIER_NOT_FOUND');
      return true;
    },
  );
});

test('[P0] SuppliersController: getSyncStatus returns status with isSyncing true', async () => {
  const mockService: any = {
    getSupplierById: async () => ({
      ...mockSupplier,
      id: 'sup-tg-1',
      type: 'TELEGRAM_BOT',
      lastSyncAt: '2026-09-14T08:00:00.000Z',
      lastSyncError: null,
      consecutiveSyncFailures: 0,
      syncIntervalSec: 3600,
    }),
  };

  const mockQueue: any = {
    getSyncStatus: async (id: string) => ({ isSyncing: true }),
  };

  const controller = new SuppliersController(mockService, mockQueue);
  const result = await controller.getSyncStatus('550e8400-e29b-41d4-a716-446655440000');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.syncStatus.isSyncing, true);
  assert.strictEqual(result.syncStatus.lastSyncAt, '2026-09-14T08:00:00.000Z');
  assert.strictEqual(result.syncStatus.lastSyncError, null);
  assert.strictEqual(result.syncStatus.consecutiveSyncFailures, 0);
  assert.strictEqual(result.syncStatus.syncIntervalSec, 3600);
});

test('[P0] SuppliersController: getSyncStatus returns status with isSyncing false', async () => {
  const mockService: any = {
    getSupplierById: async () => ({
      ...mockSupplier,
      id: 'sup-tg-2',
      type: 'TELEGRAM_BOT',
      lastSyncAt: null,
      lastSyncError: 'ECONNREFUSED',
      consecutiveSyncFailures: 2,
      syncIntervalSec: 7200,
    }),
  };

  const mockQueue: any = {
    getSyncStatus: async (id: string) => ({ isSyncing: false }),
  };

  const controller = new SuppliersController(mockService, mockQueue);
  const result = await controller.getSyncStatus('550e8400-e29b-41d4-a716-446655440000');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.syncStatus.isSyncing, false);
  assert.strictEqual(result.syncStatus.lastSyncAt, null);
  assert.strictEqual(result.syncStatus.lastSyncError, 'ECONNREFUSED');
  assert.strictEqual(result.syncStatus.consecutiveSyncFailures, 2);
  assert.strictEqual(result.syncStatus.syncIntervalSec, 7200);
});

test('[P0] SuppliersController: testConnection returns error when TELEGRAM_SCRAPER_RELAY_URL is unset', async () => {
  const origRelayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origRelayToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  delete process.env.TELEGRAM_SCRAPER_RELAY_URL;
  delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;

  try {
    const controller = new SuppliersController({} as any, {} as any);
    const result = await controller.testConnection();

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'TELEGRAM_SCRAPER_RELAY_URL not configured');
  } finally {
    if (origRelayUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origRelayUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;
    if (origRelayToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origRelayToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});

test('[P0] SuppliersController: testConnection returns ok true and status healthy when relay responds 200', async () => {
  const origRelayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origRelayToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  const origFetch = globalThis.fetch;

  process.env.TELEGRAM_SCRAPER_RELAY_URL = 'http://relay:3800';
  process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = 'secret-token-123';

  let capturedUrl = '';
  let capturedHeaders: any = null;

  globalThis.fetch = (async (url: any, opts: any) => {
    capturedUrl = String(url);
    capturedHeaders = opts?.headers;
    return new Response(JSON.stringify({ ok: true, status: 'healthy', busy: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    const controller = new SuppliersController({} as any, {} as any);
    const result = await controller.testConnection();

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'healthy');
    assert.strictEqual(capturedUrl, 'http://relay:3800/health');
    assert.strictEqual(capturedHeaders?.Authorization, 'Bearer secret-token-123');
  } finally {
    globalThis.fetch = origFetch;
    if (origRelayUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origRelayUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;
    if (origRelayToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origRelayToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});

test('[P0] SuppliersController: testConnection normalizes relay URL with /relay suffix and trailing slashes', async () => {
  const origRelayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origRelayToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  const origFetch = globalThis.fetch;

  process.env.TELEGRAM_SCRAPER_RELAY_URL = 'http://relay:3800/relay/';
  process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = 'token-xyz';

  let capturedUrl = '';

  globalThis.fetch = (async (url: any) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ ok: true, status: 'healthy' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    const controller = new SuppliersController({} as any, {} as any);
    const result = await controller.testConnection();

    assert.strictEqual(result.ok, true);
    assert.strictEqual(capturedUrl, 'http://relay:3800/health');
  } finally {
    globalThis.fetch = origFetch;
    if (origRelayUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origRelayUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;
    if (origRelayToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origRelayToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});

test('[P0] SuppliersController: testConnection returns ok false when relay returns 503 or error status', async () => {
  const origRelayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origRelayToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  const origFetch = globalThis.fetch;

  process.env.TELEGRAM_SCRAPER_RELAY_URL = 'http://relay:3800';
  process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = 'test-token';

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ ok: false, status: 'permanently_unhealthy', error: 'SESSION_BANNED' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    const controller = new SuppliersController({} as any, {} as any);
    const result = await controller.testConnection();

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'permanently_unhealthy');
    assert.strictEqual(result.error, 'SESSION_BANNED');
  } finally {
    globalThis.fetch = origFetch;
    if (origRelayUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origRelayUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;
    if (origRelayToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origRelayToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});

test('[P0] SuppliersController: testConnection handles fetch network failure', async () => {
  const origRelayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origRelayToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  const origFetch = globalThis.fetch;

  process.env.TELEGRAM_SCRAPER_RELAY_URL = 'http://relay:3800';
  process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = 'test-token';

  globalThis.fetch = (async () => {
    throw new Error('fetch failed: ECONNREFUSED');
  }) as any;

  try {
    const controller = new SuppliersController({} as any, {} as any);
    const result = await controller.testConnection();

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'fetch failed: ECONNREFUSED');
  } finally {
    globalThis.fetch = origFetch;
    if (origRelayUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origRelayUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;
    if (origRelayToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origRelayToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});

test('[P0] SuppliersController: testConnection returns error when TELEGRAM_SCRAPER_RELAY_TOKEN is unset', async () => {
  const origRelayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origRelayToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;

  process.env.TELEGRAM_SCRAPER_RELAY_URL = 'http://relay:3800';
  delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;

  try {
    const controller = new SuppliersController({} as any, {} as any);
    const result = await controller.testConnection();

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'TELEGRAM_SCRAPER_RELAY_TOKEN not configured');
  } finally {
    if (origRelayUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origRelayUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;
    if (origRelayToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origRelayToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});

test('[P0] SuppliersController: testConnection returns error for invalid protocol', async () => {
  const origRelayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origRelayToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;

  process.env.TELEGRAM_SCRAPER_RELAY_URL = 'ftp://relay:3800';
  process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = 'test-token';

  try {
    const controller = new SuppliersController({} as any, {} as any);
    const result = await controller.testConnection();

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'TELEGRAM_SCRAPER_RELAY_URL must use http:// or https://');
  } finally {
    if (origRelayUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origRelayUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;
    if (origRelayToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origRelayToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});
