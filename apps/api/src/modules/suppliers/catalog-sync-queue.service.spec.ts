import { test } from 'node:test';
import assert from 'node:assert';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { CatalogSyncQueueService } from './catalog-sync-queue.service';
import { CATALOG_SYNC_QUEUE_NAME } from '@repo/shared-types';

function createMockRedisService(redisClientMock: any) {
  return {
    getClient: () => redisClientMock,
    withLock: async (_key: string, _ttl: number, fn: () => any) => fn(),
  } as any;
}

function serviceWithMocks(queueMock: any, redisClientMock: any): CatalogSyncQueueService {
  const redisService = createMockRedisService(redisClientMock);
  const service = new CatalogSyncQueueService(redisService);
  (service as any).queue = queueMock;
  return service;
}

test('CatalogSyncQueueService.isReady() reflects queue presence', () => {
  const service = new CatalogSyncQueueService(createMockRedisService({}));
  assert.strictEqual(service.isReady(), false);
  (service as any).queue = {};
  assert.strictEqual(service.isReady(), true);
});

test('CatalogSyncQueueService.enqueueSyncJob() throws ServiceUnavailableException if queue not ready', async () => {
  const service = new CatalogSyncQueueService(createMockRedisService({}));
  await assert.rejects(
    async () => service.enqueueSyncJob('sup-1'),
    (err: any) => {
      assert.ok(err instanceof ServiceUnavailableException);
      const res = err.getResponse() as any;
      assert.strictEqual(res.errorCode, 'QUEUE_UNAVAILABLE');
      return true;
    }
  );
});

test('CatalogSyncQueueService.enqueueSyncJob() acquires lock and enqueues job on happy path', async () => {
  let setKey = '';
  let setVal = '';
  let setEx = 0;
  let setNx = '';
  const mockRedis = {
    set: async (key: string, val: string, exFlag: string, exSec: number, nxFlag: string) => {
      setKey = key;
      setVal = val;
      setEx = exSec;
      setNx = nxFlag;
      return 'OK';
    },
    del: async () => 1,
  };

  let addedName = '';
  let addedData: any = null;
  let addedOpts: any = null;
  const mockQueue = {
    getJob: async () => null,
    add: async (name: string, data: any, opts: any) => {
      addedName = name;
      addedData = data;
      addedOpts = opts;
      return { id: opts.jobId };
    },
  };

  const service = serviceWithMocks(mockQueue, mockRedis);
  const res = await service.enqueueSyncJob('sup-123', 7200);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.jobId, 'sync:sup-123');
  assert.strictEqual(setKey, 'catalog-sync:debounce:sup-123');
  assert.strictEqual(setVal, '1');
  assert.strictEqual(setEx, 7200);
  assert.strictEqual(setNx, 'NX');
  assert.strictEqual(addedName, 'sync-supplier-catalog');
  assert.deepStrictEqual(addedData, { supplierId: 'sup-123' });
  assert.strictEqual(addedOpts.jobId, 'sync:sup-123');
  // removeOnComplete keeps last 10 completed jobs so getJob() can find
  // them during debounce cooldown — prevents false zombie-lock detection.
  assert.deepStrictEqual(addedOpts.removeOnComplete, { count: 10 });
  assert.deepStrictEqual(addedOpts.removeOnFail, { count: 10 });
});

test('CatalogSyncQueueService.enqueueSyncJob() removes old completed or failed job before re-adding', async () => {
  const mockRedis = {
    set: async () => 'OK',
    del: async () => 1,
  };

  let removedCount = 0;
  const mockExistingJob = {
    getState: async () => 'completed',
    remove: async () => {
      removedCount++;
    },
  };

  const mockQueue = {
    getJob: async (jobId: string) => {
      if (jobId === 'sync:sup-123') return mockExistingJob;
      return null;
    },
    add: async (_name: string, _data: any, opts: any) => ({ id: opts.jobId }),
  };

  const service = serviceWithMocks(mockQueue, mockRedis);
  const res = await service.enqueueSyncJob('sup-123');

  assert.strictEqual(res.ok, true);
  assert.strictEqual(removedCount, 1);
});

test('CatalogSyncQueueService.enqueueSyncJob() throws 409 ConflictException when debounce locked and job is active', async () => {
  const mockRedis = {
    set: async () => null, // Lock not acquired
  };

  const mockExistingJob = {
    getState: async () => 'active',
  };

  const mockQueue = {
    getJob: async () => mockExistingJob,
  };

  const service = serviceWithMocks(mockQueue, mockRedis);
  await assert.rejects(
    async () => service.enqueueSyncJob('sup-123'),
    (err: any) => {
      assert.ok(err instanceof ConflictException);
      const res = err.getResponse() as any;
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.errorCode, 'SYNC_DEBOUNCED');
      return true;
    }
  );
});

test('CatalogSyncQueueService.enqueueSyncJob() recovers from zombie lock when Redis key exists but BullMQ job is missing', async () => {
  let deletedKey = '';
  let resetKey = '';
  let setAttempts = 0;

  const mockRedis = {
    set: async (key: string, _val: string, _ex: string, _ttl: number, nx?: string) => {
      setAttempts++;
      if (nx === 'NX') {
        return null; // Lock initially held
      }
      resetKey = key;
      return 'OK';
    },
    del: async (key: string) => {
      deletedKey = key;
      return 1;
    },
  };

  const mockQueue = {
    getJob: async () => null, // No job in BullMQ -> zombie lock!
    add: async (_name: string, _data: any, opts: any) => ({ id: opts.jobId }),
  };

  const service = serviceWithMocks(mockQueue, mockRedis);
  const res = await service.enqueueSyncJob('sup-zombie', 3600);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(deletedKey, 'catalog-sync:debounce:sup-zombie');
  assert.strictEqual(resetKey, 'catalog-sync:debounce:sup-zombie');
  assert.strictEqual(setAttempts, 2);
});

test('CatalogSyncQueueService.enqueueSyncJob() recovers from zombie lock when Redis key exists but BullMQ job state is failed', async () => {
  let deletedKey = '';
  let resetKey = '';

  const mockRedis = {
    set: async (key: string, _val: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx === 'NX') return null;
      resetKey = key;
      return 'OK';
    },
    del: async (key: string) => {
      deletedKey = key;
      return 1;
    },
  };

  let removedJob = false;
  const mockFailedJob = {
    getState: async () => 'failed',
    remove: async () => {
      removedJob = true;
    },
  };

  const mockQueue = {
    getJob: async () => mockFailedJob,
    add: async (_name: string, _data: any, opts: any) => ({ id: opts.jobId }),
  };

  const service = serviceWithMocks(mockQueue, mockRedis);
  const res = await service.enqueueSyncJob('sup-failed', 3600);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(deletedKey, 'catalog-sync:debounce:sup-failed');
  assert.strictEqual(resetKey, 'catalog-sync:debounce:sup-failed');
  assert.strictEqual(removedJob, true);
});

test('CatalogSyncQueueService.isSyncing() and getSyncStatus() accurately reflect job state', async () => {
  let queryState = 'waiting';
  const mockQueue = {
    getJob: async (id: string) => {
      if (id === 'sync:active-sup') {
        return { getState: async () => queryState };
      }
      return null;
    },
  };

  const service = serviceWithMocks(mockQueue, {});

  // waiting -> true
  assert.strictEqual(await service.isSyncing('active-sup'), true);
  assert.deepStrictEqual(await service.getSyncStatus('active-sup'), { isSyncing: true });

  // active -> true
  queryState = 'active';
  assert.strictEqual(await service.isSyncing('active-sup'), true);

  // completed -> false
  queryState = 'completed';
  assert.strictEqual(await service.isSyncing('active-sup'), false);

  // failed -> false
  queryState = 'failed';
  assert.strictEqual(await service.isSyncing('active-sup'), false);

  // non-existent -> false
  assert.strictEqual(await service.isSyncing('missing-sup'), false);
  assert.deepStrictEqual(await service.getSyncStatus('missing-sup'), { isSyncing: false });
});

test('CatalogSyncQueueService.clearDebounce() deletes the Redis key', async () => {
  let delKey = '';
  const mockRedis = {
    del: async (key: string) => {
      delKey = key;
      return 1;
    },
  };

  const service = serviceWithMocks({}, mockRedis);
  await service.clearDebounce('sup-del');
  assert.strictEqual(delKey, 'catalog-sync:debounce:sup-del');
});

test('CatalogSyncQueueService.onModuleDestroy() safely closes queue and disconnects connection', async () => {
  let queueClosed = false;
  let connectionDisconnected = false;

  const service = new CatalogSyncQueueService(createMockRedisService({}));
  (service as any).queue = {
    close: async () => {
      queueClosed = true;
    },
  };
  (service as any).connection = {
    disconnect: () => {
      connectionDisconnected = true;
    },
  };

  await service.onModuleDestroy();
  assert.strictEqual(queueClosed, true);
  assert.strictEqual(connectionDisconnected, true);
});
