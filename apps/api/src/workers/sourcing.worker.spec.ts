import { test } from 'node:test';
import assert from 'node:assert';
import { SourcingWorker } from './sourcing.worker';

test('[P1] SourcingWorker: does not construct worker when SOURCING_WORKER_DISABLED=true', async () => {
  const orig = process.env.SOURCING_WORKER_DISABLED;
  process.env.SOURCING_WORKER_DISABLED = 'true';
  try {
    const worker = new SourcingWorker({} as any);
    await worker.onModuleInit();
    assert.strictEqual((worker as any).worker, undefined);
    assert.strictEqual((worker as any).connection, undefined);
  } finally {
    if (orig !== undefined) process.env.SOURCING_WORKER_DISABLED = orig;
    else delete process.env.SOURCING_WORKER_DISABLED;
  }
});

test('[P1] SourcingWorker: onModuleDestroy gracefully closes worker and disconnects redis', async () => {
  const worker = new SourcingWorker({} as any);
  let workerClosed = false;
  let redisDisconnected = false;

  (worker as any).worker = {
    close: async () => {
      workerClosed = true;
    },
  };
  (worker as any).connection = {
    disconnect: () => {
      redisDisconnected = true;
    },
  };

  await worker.onModuleDestroy();

  assert.strictEqual(workerClosed, true);
  assert.strictEqual(redisDisconnected, true);
});

test('[P2] SourcingWorker: onModuleDestroy is safe when worker/connection are undefined', async () => {
  const worker = new SourcingWorker({} as any);
  await assert.doesNotReject(async () => {
    await worker.onModuleDestroy();
  });
});

test('[P0] SourcingWorker: onModuleInit configures Worker with correct queue, lockDuration, maxStalledCount and concurrency', async () => {
  const origDisabled = process.env.SOURCING_WORKER_DISABLED;
  const origConcurrency = process.env.SOURCING_WORKER_CONCURRENCY;

  delete process.env.SOURCING_WORKER_DISABLED;
  process.env.SOURCING_WORKER_CONCURRENCY = '5';

  let capturedQueueName: string | null = null;
  let capturedOpts: any = null;
  let capturedUrl: string | null = null;

  class TestableSourcingWorker extends SourcingWorker {
    protected override createConnection(url: string): any {
      capturedUrl = url;
      return {
        disconnect: () => {},
        on: () => {},
      };
    }

    protected override createWorker(
      queueName: string,
      _processor: any,
      opts: any,
    ): any {
      capturedQueueName = queueName;
      capturedOpts = opts;
      return {
        on: () => {},
        close: async () => {},
      };
    }
  }

  try {
    const mockExecutor = { execute: async () => {} };
    const worker = new TestableSourcingWorker(mockExecutor as any);
    await worker.onModuleInit();

    assert.strictEqual(capturedQueueName, 'sourcing-queue');
    assert.strictEqual(capturedOpts.concurrency, 5);
    assert.strictEqual(capturedOpts.lockDuration, 60000);
    assert.strictEqual(capturedOpts.maxStalledCount, 2);
    assert.strictEqual(capturedUrl, 'redis://localhost:6381');
  } finally {
    if (origDisabled !== undefined)
      process.env.SOURCING_WORKER_DISABLED = origDisabled;
    else delete process.env.SOURCING_WORKER_DISABLED;
    if (origConcurrency !== undefined)
      process.env.SOURCING_WORKER_CONCURRENCY = origConcurrency;
    else delete process.env.SOURCING_WORKER_CONCURRENCY;
  }
});

test('[P0] SourcingWorker: registered processor callback delegates to executor.execute(job)', async () => {
  let capturedProcessor: any = null;
  let executedJob: any = null;

  class TestableSourcingWorker extends SourcingWorker {
    protected override createConnection(): any {
      return { disconnect: () => {}, on: () => {} };
    }

    protected override createWorker(_name: string, processor: any): any {
      capturedProcessor = processor;
      return { on: () => {}, close: async () => {} };
    }
  }

  const mockExecutor = {
    execute: async (job: any) => {
      executedJob = job;
    },
  };

  const worker = new TestableSourcingWorker(mockExecutor as any);
  await worker.onModuleInit();

  assert(typeof capturedProcessor === 'function');
  const fakeJob = { id: 'job-1', data: { orderId: 'order-123' } };
  await capturedProcessor(fakeJob);

  assert.deepStrictEqual(executedJob, fakeJob);
});
