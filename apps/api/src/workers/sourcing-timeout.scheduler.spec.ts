import { test } from 'node:test';
import assert from 'node:assert';

/**
 * Red-phase ATDD Scaffolds for Story 4.4:
 * Sourcing Timeout & Sweeper Scheduler (AC #1, AC #2)
 * Target implementation: apps/api/src/workers/sourcing-timeout.scheduler.ts
 *
 * All tests use test() for RED phase compliance.
 */

test('[P0] SourcingTimeoutScheduler: scheduleTimeout enqueues delayed job with delay: 60000 and deterministic jobId', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Scheduler not implemented yet
  const { SourcingTimeoutScheduler } = await import('./sourcing-timeout.scheduler' as string);

  let addedJob: any = null;
  const mockQueue = {
    add: async (name: string, data: any, opts: any) => {
      addedJob = { name, data, opts };
      return { id: opts.jobId };
    },
  };

  const scheduler = new SourcingTimeoutScheduler({} as any);
  (scheduler as any).queue = mockQueue;

  await scheduler.scheduleTimeout('order-timeout-123', 60_000);

  assert.ok(addedJob, 'A job must be added to the queue');
  assert.strictEqual(addedJob.data.orderId, 'order-timeout-123');
  assert.strictEqual(addedJob.opts.delay, 60_000, 'Delay must be exactly 60,000ms');
  assert.strictEqual(addedJob.opts.jobId, 'sourcing-timeout:order-timeout-123', 'jobId must follow sourcing-timeout:<orderId> convention');
});

test('[P0] SourcingTimeoutScheduler: worker processor calls cancelAndRefund for timeout job with DELAYED_TIMEOUT source', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Scheduler not implemented yet
  const { SourcingTimeoutScheduler } = await import('./sourcing-timeout.scheduler' as string);

  let cancelArgs: any = null;
  const mockSourcingTimeoutService = {
    cancelAndRefund: async (orderId: string, reason: string, source: string) => {
      cancelArgs = { orderId, reason, source };
      return { refunded: true };
    },
    sweepExpiredOrders: async () => 0,
  };

  const scheduler = new SourcingTimeoutScheduler(mockSourcingTimeoutService as any);

  // Directly invoke the job processor handler
  const mockJob = {
    name: 'sourcing-timeout',
    data: { orderId: 'order-expired-456' },
  };

  await (scheduler as any).processJob(mockJob);

  assert.ok(cancelArgs, 'cancelAndRefund must be called');
  assert.strictEqual(cancelArgs.orderId, 'order-expired-456');
  assert.strictEqual(cancelArgs.reason, 'SOURCING_TIMEOUT_60S');
  assert.strictEqual(cancelArgs.source, 'DELAYED_TIMEOUT');
});

test('[P1] SourcingTimeoutScheduler: registers periodic sweeper with SOURCING_SWEEPER_INTERVAL_MS', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Scheduler not implemented yet
  const { SourcingTimeoutScheduler } = await import('./sourcing-timeout.scheduler' as string);

  let scheduledCron: any = null;
  const mockQueue = {
    upsertJobScheduler: async (id: string, repeatOpts: any, jobTemplate: any) => {
      scheduledCron = { id, repeatOpts, jobTemplate };
    },
  };

  const origInterval = process.env.SOURCING_SWEEPER_INTERVAL_MS;
  process.env.SOURCING_SWEEPER_INTERVAL_MS = '15000';
  try {
    const scheduler = new SourcingTimeoutScheduler({} as any);
    (scheduler as any).queue = mockQueue;
    await (scheduler as any).initPeriodicSweeper();

    assert.ok(scheduledCron, 'Sweeper scheduler must be registered');
    assert.strictEqual(scheduledCron.id, 'sourcing-sweeper-tick');
    assert.strictEqual(scheduledCron.repeatOpts.every, 15000);
    assert.strictEqual(scheduledCron.jobTemplate.name, 'sweep');
  } finally {
    if (origInterval !== undefined) process.env.SOURCING_SWEEPER_INTERVAL_MS = origInterval;
    else delete process.env.SOURCING_SWEEPER_INTERVAL_MS;
  }
});

test('[P1] SourcingTimeoutScheduler: worker processor calls sweepExpiredOrders when processing sweep job', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Scheduler not implemented yet
  const { SourcingTimeoutScheduler } = await import('./sourcing-timeout.scheduler' as string);

  let sweepCalledWithSeconds: number | null = null;
  const mockSourcingTimeoutService = {
    cancelAndRefund: async () => ({ refunded: false }),
    sweepExpiredOrders: async (seconds: number) => {
      sweepCalledWithSeconds = seconds;
      return 3;
    },
  };

  const scheduler = new SourcingTimeoutScheduler(mockSourcingTimeoutService as any);

  const mockJob = {
    name: 'sweep',
    data: {},
  };

  await (scheduler as any).processJob(mockJob);

  assert.strictEqual(sweepCalledWithSeconds, 60, 'sweepExpiredOrders must be invoked with 60 seconds threshold');
});

test('[P1] SourcingTimeoutScheduler: onModuleDestroy gracefully closes queue, worker, and disconnects redis', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Scheduler not implemented yet
  const { SourcingTimeoutScheduler } = await import('./sourcing-timeout.scheduler' as string);

  let queueClosed = false;
  let workerClosed = false;
  let redisDisconnected = false;

  const scheduler = new SourcingTimeoutScheduler({} as any);
  (scheduler as any).queue = { close: async () => { queueClosed = true; } };
  (scheduler as any).worker = { close: async () => { workerClosed = true; } };
  (scheduler as any).connection = { disconnect: () => { redisDisconnected = true; } };

  await scheduler.onModuleDestroy();

  assert.strictEqual(queueClosed, true, 'Queue must be closed');
  assert.strictEqual(workerClosed, true, 'Worker must be closed');
  assert.strictEqual(redisDisconnected, true, 'Redis connection must be disconnected');
});

test('[P2] SourcingTimeoutScheduler: does not construct queue/worker when SOURCING_TIMEOUT_DISABLED=true', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Scheduler not implemented yet
  const { SourcingTimeoutScheduler } = await import('./sourcing-timeout.scheduler' as string);

  const orig = process.env.SOURCING_TIMEOUT_DISABLED;
  process.env.SOURCING_TIMEOUT_DISABLED = 'true';
  try {
    const scheduler = new SourcingTimeoutScheduler({} as any);
    await scheduler.onModuleInit();
    assert.strictEqual((scheduler as any).queue, undefined);
    assert.strictEqual((scheduler as any).worker, undefined);
    assert.strictEqual((scheduler as any).connection, undefined);
  } finally {
    if (orig !== undefined) process.env.SOURCING_TIMEOUT_DISABLED = orig;
    else delete process.env.SOURCING_TIMEOUT_DISABLED;
  }
});

test('[P2] SourcingTimeoutScheduler: onModuleDestroy handles uninitialized queue/worker safely without throwing', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Scheduler not implemented yet
  const { SourcingTimeoutScheduler } = await import('./sourcing-timeout.scheduler' as string);

  const scheduler = new SourcingTimeoutScheduler({} as any);
  await assert.doesNotReject(async () => {
    await scheduler.onModuleDestroy();
  });
});
