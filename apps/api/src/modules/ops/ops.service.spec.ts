import { test } from 'node:test';
import assert from 'node:assert';
import {
  ServiceUnavailableException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { OpsService } from './ops.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueueMock(overrides: Partial<{
  getFailed: (start: number, end: number) => Promise<any[]>;
  getJob: (id: string) => Promise<any>;
  getJobCounts: (...types: string[]) => Promise<Record<string, number>>;
}> = {}) {
  return {
    getFailed: overrides.getFailed ?? (async () => []),
    getJob: overrides.getJob ?? (async () => null),
    getJobCounts: overrides.getJobCounts ?? (async () => ({ failed: 0 })),
  };
}

function makeService(queueMock: any, dbRows: { aggRow?: any; latRow?: any; supplierRows?: any[] } = {}) {
  const queue = queueMock === null ? undefined : queueMock;
  const svc = new OpsService({ getQueue: () => queue } as any);

  // Stub db.execute to return canned rows
  const aggRow = dbRows.aggRow ?? { total_attempts: '10', timeout_count: '2', sweeper_count: '1' };
  const latRow = dbRows.latRow ?? { avg_ms: '3000.5' };
  const supplierRows = dbRows.supplierRows ?? [];

  let callCount = 0;
  (svc as any).dbClient = undefined; // not used directly — db is imported statically
  // Patch the module-level `db` via monkey-patching the private field is not possible;
  // instead we spy on db.execute by replacing the imported binding's execute method.
  // The cleanest approach: patch the imported `db` object's execute method.
  // Since `db` is a singleton, we temporarily override it.
  return { svc, aggRow, latRow, supplierRows };
}

// Because `db` is a singleton import, we monkey-patch `execute` per test.
// Each test wraps its own execute mock via the helper below.
function withDb(executeImpl: (q: any) => Promise<{ rows: any[] }>, fn: () => Promise<void>) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dbModule = require('@repo/database');
  const original = dbModule.db.execute;
  dbModule.db.execute = executeImpl;
  return fn().finally(() => {
    dbModule.db.execute = original;
  });
}

// ---------------------------------------------------------------------------
// getMetrics
// ---------------------------------------------------------------------------

test('getMetrics returns zeroed metrics when no supplier_orders exist', async () => {
  const svc = new OpsService({ getQueue: () => makeQueueMock() } as any);

  const dbExecute = async () => ({
    rows: [{ total_attempts: '0', timeout_count: '0', sweeper_count: '0' }],
  });
  // Second call returns latency null
  let call = 0;
  const mockExecute = async () => {
    call++;
    if (call === 1) return { rows: [{ total_attempts: '0', timeout_count: '0', sweeper_count: '0' }] };
    if (call === 2) return { rows: [{ avg_ms: null }] };
    return { rows: [] };
  };

  const dbModule = require('@repo/database');
  const orig = dbModule.db.execute;
  dbModule.db.execute = mockExecute;
  try {
    const result = await svc.getMetrics(24);
    assert.strictEqual(result.timeoutRatePct, 0);
    assert.strictEqual(result.sweeperRescueCount, 0);
    assert.strictEqual(result.avgSourcingLatencyMs, null);
    assert.strictEqual(result.totalAttempts, 0);
    assert.deepStrictEqual(result.perSupplier, []);
  } finally {
    dbModule.db.execute = orig;
  }
});

test('getMetrics computes timeoutRatePct correctly with mixed data', async () => {
  const svc = new OpsService({ getQueue: () => makeQueueMock({ getJobCounts: async () => ({ failed: 3 }) }) } as any);

  let call = 0;
  const mockExecute = async () => {
    call++;
    if (call === 1) return { rows: [{ total_attempts: '20', timeout_count: '4', sweeper_count: '2' }] };
    if (call === 2) return { rows: [{ avg_ms: '4500.7' }] };
    return { rows: [] };
  };

  const dbModule = require('@repo/database');
  const orig = dbModule.db.execute;
  dbModule.db.execute = mockExecute;
  try {
    const result = await svc.getMetrics(24);
    assert.strictEqual(result.timeoutRatePct, 20);
    assert.strictEqual(result.sweeperRescueCount, 2);
    assert.strictEqual(result.avgSourcingLatencyMs, 4501);
    assert.strictEqual(result.failedJobCount, 3);
    assert.strictEqual(result.totalAttempts, 20);
  } finally {
    dbModule.db.execute = orig;
  }
});

test('getMetrics maps perSupplier rows with null supplier name fallback', async () => {
  const svc = new OpsService({ getQueue: () => makeQueueMock() } as any);

  let call = 0;
  const mockExecute = async () => {
    call++;
    if (call === 1) return { rows: [{ total_attempts: '5', timeout_count: '0', sweeper_count: '0' }] };
    if (call === 2) return { rows: [{ avg_ms: null }] };
    return {
      rows: [
        {
          supplier_source_id: null,
          supplier_name: null,
          success_count: '3',
          fail_count: '2',
          avg_latency_ms: '1200.4',
          timeout_count: '1',
        },
        {
          supplier_source_id: 'sup-1',
          supplier_name: 'Supplier A',
          success_count: '7',
          fail_count: '0',
          avg_latency_ms: '800.0',
          timeout_count: '0',
        },
      ],
    };
  };

  const dbModule = require('@repo/database');
  const orig = dbModule.db.execute;
  dbModule.db.execute = mockExecute;
  try {
    const result = await svc.getMetrics(24);
    assert.strictEqual(result.perSupplier.length, 2);
    assert.strictEqual(result.perSupplier[0].supplierName, 'Chưa xác định');
    assert.strictEqual(result.perSupplier[0].supplierSourceId, null);
    assert.strictEqual(result.perSupplier[0].avgLatencyMs, 1200);
    assert.strictEqual(result.perSupplier[1].supplierName, 'Supplier A');
    assert.strictEqual(result.perSupplier[1].avgLatencyMs, 800);
  } finally {
    dbModule.db.execute = orig;
  }
});

// ---------------------------------------------------------------------------
// getFailedJobs
// ---------------------------------------------------------------------------

test('getFailedJobs throws ServiceUnavailableException when queue is not ready', async () => {
  const svc = new OpsService({ getQueue: () => undefined } as any);
  await assert.rejects(() => svc.getFailedJobs(20), ServiceUnavailableException);
});

test('getFailedJobs returns empty array when queue has no failures', async () => {
  const queue = makeQueueMock({ getFailed: async () => [] });
  const svc = new OpsService({ getQueue: () => queue } as any);
  const jobs = await svc.getFailedJobs(20);
  assert.deepStrictEqual(jobs, []);
});

test('getFailedJobs maps BullMQ job fields to FailedJobDto correctly', async () => {
  const fakeJob = {
    id: 'order-uuid-abc',
    data: { orderId: 'order-uuid-abc', productId: 'prod-1', supplierSourceId: 'sup-1' },
    failedReason: 'RETRY_EXHAUSTED:Purchase timed out after 45000ms',
    attemptsMade: 3,
    finishedOn: 1757740000000,
    timestamp: 1757740000000,
  };
  const queue = makeQueueMock({ getFailed: async () => [fakeJob] });
  const svc = new OpsService({ getQueue: () => queue } as any);
  const jobs = await svc.getFailedJobs(10);

  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].jobId, 'order-uuid-abc');
  assert.strictEqual(jobs[0].orderId, 'order-uuid-abc');
  assert.strictEqual(jobs[0].failedReason, 'RETRY_EXHAUSTED:Purchase timed out after 45000ms');
  assert.strictEqual(jobs[0].attemptsMade, 3);
  assert.strictEqual(jobs[0].failedAt, new Date(1757740000000).toISOString());
});

test('getFailedJobs falls back to job.timestamp when finishedOn is undefined', async () => {
  const fakeJob = {
    id: 'job-2',
    data: { orderId: 'o-2', productId: 'p-2', supplierSourceId: 's-2' },
    failedReason: 'Network error',
    attemptsMade: 1,
    finishedOn: undefined,
    timestamp: 1757700000000,
  };
  const queue = makeQueueMock({ getFailed: async () => [fakeJob] });
  const svc = new OpsService({ getQueue: () => queue } as any);
  const jobs = await svc.getFailedJobs(10);
  assert.strictEqual(jobs[0].failedAt, new Date(1757700000000).toISOString());
});

// ---------------------------------------------------------------------------
// retryFailedJob
// ---------------------------------------------------------------------------

test('retryFailedJob throws NotFoundException for missing job', async () => {
  const queue = makeQueueMock({ getJob: async () => null });
  const svc = new OpsService({ getQueue: () => queue } as any);
  await assert.rejects(() => svc.retryFailedJob('nonexistent'), NotFoundException);
});

test('retryFailedJob throws ConflictException for active job', async () => {
  const job = { getState: async () => 'active', retry: async () => {} };
  const queue = makeQueueMock({ getJob: async () => job });
  const svc = new OpsService({ getQueue: () => queue } as any);
  await assert.rejects(() => svc.retryFailedJob('job-1'), ConflictException);
});

test('retryFailedJob throws ConflictException for completed job', async () => {
  const job = { getState: async () => 'completed', retry: async () => {} };
  const queue = makeQueueMock({ getJob: async () => job });
  const svc = new OpsService({ getQueue: () => queue } as any);
  await assert.rejects(() => svc.retryFailedJob('job-1'), ConflictException);
});

test('retryFailedJob calls job.retry() and returns waiting state for failed job', async () => {
  let retried = false;
  const job = {
    getState: async () => 'failed',
    retry: async () => { retried = true; },
    data: { orderId: 'o-1' },
  };
  const queue = makeQueueMock({ getJob: async () => job });
  const svc = new OpsService({ getQueue: () => queue } as any);

  const result = await svc.retryFailedJob('job-1');
  assert.strictEqual(retried, true);
  assert.strictEqual(result.state, 'waiting');
  assert.strictEqual(result.jobId, 'job-1');
});

test('retryFailedJob throws ServiceUnavailableException when queue is down', async () => {
  const svc = new OpsService({ getQueue: () => undefined } as any);
  await assert.rejects(() => svc.retryFailedJob('job-1'), ServiceUnavailableException);
});
