import { test } from 'node:test';
import assert from 'node:assert';
import { ServiceUnavailableException } from '@nestjs/common';
import { SourcingQueueService } from './sourcing-queue.service';
import { SOURCING_QUEUE_NAME } from '@repo/shared-types';

const jobData = {
  orderId: 'order-uuid-1',
  productId: 'prod-uuid-1',
  supplierSourceId: 'sup-uuid-1',
};

function serviceWithQueue(queueMock: any): SourcingQueueService {
  const service = new SourcingQueueService();
  (service as any).queue = queueMock;
  return service;
}

test('ensureSourcingJob adds job with full contract options when job is missing', async () => {
  const addCalls: any[] = [];
  const service = serviceWithQueue({
    getJob: async () => null,
    add: async (name: string, data: any, opts: any) => {
      addCalls.push({ name, data, opts });
    },
  });

  await service.ensureSourcingJob(jobData);

  assert.strictEqual(addCalls.length, 1);
  assert.strictEqual(addCalls[0].name, 'source-order');
  assert.deepStrictEqual(addCalls[0].data, jobData);
  assert.strictEqual(addCalls[0].opts.jobId, 'order-uuid-1');
  assert.strictEqual(addCalls[0].opts.attempts, 3);
  assert.deepStrictEqual(addCalls[0].opts.backoff, {
    type: 'exponential',
    delay: 2000,
  });
  assert.strictEqual(addCalls[0].opts.removeOnComplete, true);
  assert.deepStrictEqual(addCalls[0].opts.removeOnFail, { count: 100 });
});

test('ensureSourcingJob retries a failed job instead of re-adding (dedup pin)', async () => {
  let addCalls = 0;
  let retryCalls = 0;
  const service = serviceWithQueue({
    getJob: async () => ({
      getState: async () => 'failed',
      retry: async () => {
        retryCalls++;
      },
    }),
    add: async () => {
      addCalls++;
    },
  });

  await service.ensureSourcingJob(jobData);

  assert.strictEqual(retryCalls, 1);
  assert.strictEqual(addCalls, 0);
});

test('ensureSourcingJob is a no-op when a healthy job already exists', async () => {
  let addCalls = 0;
  let retryCalls = 0;
  const service = serviceWithQueue({
    getJob: async () => ({
      getState: async () => 'waiting',
      retry: async () => {
        retryCalls++;
      },
    }),
    add: async () => {
      addCalls++;
    },
  });

  await service.ensureSourcingJob(jobData);

  assert.strictEqual(addCalls, 0);
  assert.strictEqual(retryCalls, 0);
});

test('ensureSourcingJob throws ServiceUnavailableException when queue not initialized', async () => {
  const service = new SourcingQueueService();
  await assert.rejects(
    () => service.ensureSourcingJob(jobData),
    (err: any) => {
      assert.ok(err instanceof ServiceUnavailableException);
      assert.strictEqual(
        (err.getResponse() as any).errorCode,
        'SOURCING_UNAVAILABLE',
      );
      return true;
    },
  );
});

test('ensureSourcingJob wraps queue errors into SOURCING_UNAVAILABLE', async () => {
  const service = serviceWithQueue({
    getJob: async () => null,
    add: async () => {
      throw new Error('READONLY You can\'t write against a read only replica');
    },
  });

  await assert.rejects(
    () => service.ensureSourcingJob(jobData),
    (err: any) => {
      assert.ok(err instanceof ServiceUnavailableException);
      assert.strictEqual(
        (err.getResponse() as any).errorCode,
        'SOURCING_UNAVAILABLE',
      );
      return true;
    },
  );
});

test('ensureSourcingJob bounds a hanging add with a timeout → SOURCING_UNAVAILABLE', async () => {
  const service = serviceWithQueue({
    getJob: async () => null,
    // Settles after a bounded delay ≫ enqueueTimeoutMs — simulates dead Redis
    // while still letting the event loop drain so node:test doesn't flag a
    // dangling promise at file exit.
    add: async () =>
      new Promise((resolve) => setTimeout(() => resolve({}), 200)),
  });
  (service as any).enqueueTimeoutMs = 30;

  await assert.rejects(
    () => service.ensureSourcingJob(jobData),
    (err: any) => {
      assert.ok(err instanceof ServiceUnavailableException);
      return true;
    },
  );
});

test('isReady reflects queue initialization state', () => {
  const service = new SourcingQueueService();
  assert.strictEqual(service.isReady(), false);
  (service as any).queue = {};
  assert.strictEqual(service.isReady(), true);
});

test('onModuleDestroy is safe when queue was never initialized', async () => {
  const service = new SourcingQueueService();
  await service.onModuleDestroy(); // must not throw
});

test('SOURCING_QUEUE_NAME constant is the architecture-defined queue name', () => {
  assert.strictEqual(SOURCING_QUEUE_NAME, 'sourcing-queue');
});
