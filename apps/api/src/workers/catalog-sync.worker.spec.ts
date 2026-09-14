import { test } from 'node:test';
import assert from 'node:assert';
import { CatalogSyncWorker } from './catalog-sync.worker';
import { CATALOG_SYNC_QUEUE_NAME } from '@repo/shared-types';

test('[P0] CatalogSyncWorker skips startup when CATALOG_SYNC_WORKER_DISABLED=true', async () => {
  const origDisabled = process.env.CATALOG_SYNC_WORKER_DISABLED;
  process.env.CATALOG_SYNC_WORKER_DISABLED = 'true';

  try {
    let connectionCreated = false;
    let workerCreated = false;

    const worker = new CatalogSyncWorker({} as any);
    (worker as any).createConnection = () => {
      connectionCreated = true;
      return { on: () => {}, disconnect: () => {} };
    };
    (worker as any).createWorker = () => {
      workerCreated = true;
      return { on: () => {}, close: async () => {} };
    };

    await worker.onModuleInit();

    assert.strictEqual(connectionCreated, false);
    assert.strictEqual(workerCreated, false);
    assert.strictEqual(worker.isReady(), false);
  } finally {
    if (origDisabled !== undefined) {
      process.env.CATALOG_SYNC_WORKER_DISABLED = origDisabled;
    } else {
      delete process.env.CATALOG_SYNC_WORKER_DISABLED;
    }
  }
});

test('[P0] CatalogSyncWorker throws on startup when TELEGRAM_BOT supplier exists but TELEGRAM_SCRAPER_RELAY_URL is unset', async () => {
  const origDisabled = process.env.CATALOG_SYNC_WORKER_DISABLED;
  const origRelayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  delete process.env.CATALOG_SYNC_WORKER_DISABLED;
  delete process.env.TELEGRAM_SCRAPER_RELAY_URL;

  try {
    const worker = new CatalogSyncWorker({} as any);
    (worker as any).db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 'sup-tg-1' }],
          }),
        }),
      }),
    };

    await assert.rejects(
      async () => worker.onModuleInit(),
      /TELEGRAM_SCRAPER_RELAY_URL environment variable is required when TELEGRAM_BOT suppliers exist/
    );
  } finally {
    if (origDisabled !== undefined) process.env.CATALOG_SYNC_WORKER_DISABLED = origDisabled;
    else delete process.env.CATALOG_SYNC_WORKER_DISABLED;

    if (origRelayUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origRelayUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;
  }
});

test('[P0] CatalogSyncWorker continues initialization if DB check throws an error on startup', async () => {
  const origDisabled = process.env.CATALOG_SYNC_WORKER_DISABLED;
  delete process.env.CATALOG_SYNC_WORKER_DISABLED;

  try {
    let workerOpts: any = null;
    let createdQueueName = '';

    const worker = new CatalogSyncWorker({} as any);
    (worker as any).db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
            },
          }),
        }),
      }),
    };

    (worker as any).createConnection = () => ({
      on: () => {},
      disconnect: () => {},
    });

    (worker as any).createWorker = (queueName: string, _processor: any, opts: any) => {
      createdQueueName = queueName;
      workerOpts = opts;
      return { on: () => {}, close: async () => {} };
    };

    await worker.onModuleInit();

    assert.strictEqual(createdQueueName, CATALOG_SYNC_QUEUE_NAME);
    assert.strictEqual(workerOpts.concurrency, 1);
    assert.strictEqual(workerOpts.lockDuration, 120_000);
    assert.strictEqual(workerOpts.maxStalledCount, 1);
    assert.strictEqual(worker.isReady(), true);
  } finally {
    if (origDisabled !== undefined) process.env.CATALOG_SYNC_WORKER_DISABLED = origDisabled;
    else delete process.env.CATALOG_SYNC_WORKER_DISABLED;
  }
});

test('[P0] CatalogSyncWorker initializes with strict serialized settings and processes job via CatalogSyncService', async () => {
  const origDisabled = process.env.CATALOG_SYNC_WORKER_DISABLED;
  const origRelayUrl = process.env.TELEGRAM_SCRAPER_RELAY_URL;
  const origRelayToken = process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  delete process.env.CATALOG_SYNC_WORKER_DISABLED;
  process.env.TELEGRAM_SCRAPER_RELAY_URL = 'http://relay:3800';
  process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = 'test-token';

  try {
    let capturedProcessor: any = null;
    let workerOpts: any = null;
    let syncedSupplierId = '';

    const mockSyncService = {
      syncSupplierCatalog: async (id: string) => {
        syncedSupplierId = id;
        return { ok: true, productsCount: 5 };
      },
    };

    const worker = new CatalogSyncWorker(mockSyncService as any);
    (worker as any).db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 'sup-tg-1' }],
          }),
        }),
      }),
    };

    (worker as any).createConnection = () => ({
      on: () => {},
      disconnect: () => {},
    });

    (worker as any).createWorker = (_queueName: string, processor: any, opts: any) => {
      capturedProcessor = processor;
      workerOpts = opts;
      return { on: () => {}, close: async () => {} };
    };

    await worker.onModuleInit();

    assert.strictEqual(workerOpts.concurrency, 1);
    assert.strictEqual(workerOpts.lockDuration, 120_000);
    assert.strictEqual(workerOpts.maxStalledCount, 1);

    // Test processor call
    await capturedProcessor({
      id: 'sync:sup-tg-1',
      data: { supplierId: 'sup-tg-1' },
    });

    assert.strictEqual(syncedSupplierId, 'sup-tg-1');
  } finally {
    if (origDisabled !== undefined) process.env.CATALOG_SYNC_WORKER_DISABLED = origDisabled;
    else delete process.env.CATALOG_SYNC_WORKER_DISABLED;

    if (origRelayUrl !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_URL = origRelayUrl;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_URL;

    if (origRelayToken !== undefined) process.env.TELEGRAM_SCRAPER_RELAY_TOKEN = origRelayToken;
    else delete process.env.TELEGRAM_SCRAPER_RELAY_TOKEN;
  }
});

test('[P1] CatalogSyncWorker onModuleDestroy safely closes worker and disconnects connection', async () => {
  let closed = false;
  let disconnected = false;

  const worker = new CatalogSyncWorker({} as any);
  (worker as any).worker = {
    close: async () => {
      closed = true;
    },
  };
  (worker as any).connection = {
    disconnect: () => {
      disconnected = true;
    },
  };

  await worker.onModuleDestroy();
  assert.strictEqual(closed, true);
  assert.strictEqual(disconnected, true);
});
