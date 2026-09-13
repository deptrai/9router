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

/**
 * Sequential db.execute mock — returns `responses[i]` on the i-th call.
 * For select() chain: returns `selectRows` from `.limit()`.
 */
function makeDbMock(responses: { rows: any[] }[] = [], selectRows: any[] = []) {
  let call = 0;
  return {
    execute: async () => responses[call++] ?? { rows: [] },
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => selectRows }),
        limit: async () => selectRows,
      }),
    }),
  };
}

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

function svc(queueMock: any, dbMock?: any): OpsService {
  return new OpsService(
    { getQueue: () => queueMock === null ? undefined : queueMock } as any,
    dbMock ?? makeDbMock(),
  );
}

// ---------------------------------------------------------------------------
// getMetrics
// ---------------------------------------------------------------------------

test('getMetrics returns zeroed metrics when no supplier_orders exist', async () => {
  const db = makeDbMock([
    { rows: [{ total_attempts: '0', timeout_count: '0', sweeper_count: '0' }] },
    { rows: [{ avg_ms: null }] },
    { rows: [] },
  ]);
  const result = await svc(makeQueueMock(), db).getMetrics(24);

  assert.strictEqual(result.timeoutRatePct, 0);
  assert.strictEqual(result.sweeperRescueCount, 0);
  assert.strictEqual(result.avgSourcingLatencyMs, null);
  assert.strictEqual(result.totalAttempts, 0);
  assert.deepStrictEqual(result.perSupplier, []);
});

test('getMetrics computes timeoutRatePct correctly with mixed data', async () => {
  const db = makeDbMock([
    { rows: [{ total_attempts: '20', timeout_count: '4', sweeper_count: '2' }] },
    { rows: [{ avg_ms: '4500.7' }] },
    { rows: [] },
  ]);
  const queue = makeQueueMock({ getJobCounts: async () => ({ failed: 3 }) });
  const result = await svc(queue, db).getMetrics(24);

  assert.strictEqual(result.timeoutRatePct, 20);
  assert.strictEqual(result.sweeperRescueCount, 2);
  assert.strictEqual(result.avgSourcingLatencyMs, 4501);
  assert.strictEqual(result.failedJobCount, 3);
  assert.strictEqual(result.totalAttempts, 20);
});

test('getMetrics maps perSupplier rows with null supplier name fallback', async () => {
  const db = makeDbMock([
    { rows: [{ total_attempts: '5', timeout_count: '0', sweeper_count: '0' }] },
    { rows: [{ avg_ms: null }] },
    {
      rows: [
        { supplier_source_id: null, supplier_name: null, success_count: '3', fail_count: '2', avg_latency_ms: '1200.4', timeout_count: '1' },
        { supplier_source_id: 'sup-1', supplier_name: 'Supplier A', success_count: '7', fail_count: '0', avg_latency_ms: '800.0', timeout_count: '0' },
      ],
    },
  ]);
  const result = await svc(makeQueueMock(), db).getMetrics(24);

  assert.strictEqual(result.perSupplier.length, 2);
  assert.strictEqual(result.perSupplier[0].supplierName, 'Chưa xác định');
  assert.strictEqual(result.perSupplier[0].supplierSourceId, null);
  assert.strictEqual(result.perSupplier[0].avgLatencyMs, 1200);
  assert.strictEqual(result.perSupplier[1].supplierName, 'Supplier A');
  assert.strictEqual(result.perSupplier[1].avgLatencyMs, 800);
});

// ---------------------------------------------------------------------------
// getFailedJobs
// ---------------------------------------------------------------------------

test('getFailedJobs throws ServiceUnavailableException when queue is not ready', async () => {
  await assert.rejects(() => svc(null).getFailedJobs(20), ServiceUnavailableException);
});

test('getFailedJobs returns empty array when queue has no failures', async () => {
  const jobs = await svc(makeQueueMock()).getFailedJobs(20);
  assert.deepStrictEqual(jobs, []);
});

test('getFailedJobs returns empty array for limit <= 0', async () => {
  const jobs = await svc(makeQueueMock()).getFailedJobs(0);
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
  const jobs = await svc(queue).getFailedJobs(10);

  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].jobId, 'order-uuid-abc');
  assert.strictEqual(jobs[0].orderId, 'order-uuid-abc');
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
  const jobs = await svc(makeQueueMock({ getFailed: async () => [fakeJob] })).getFailedJobs(10);
  assert.strictEqual(jobs[0].failedAt, new Date(1757700000000).toISOString());
});

test('getFailedJobs sanitizes failedReason — strips URLs and IPs', async () => {
  const fakeJob = {
    id: 'job-3',
    data: { orderId: 'o-3', productId: 'p-3', supplierSourceId: 's-3' },
    failedReason: 'connect ETIMEDOUT http://proxy.internal:8080/path?token=abc123 at 10.0.0.5',
    attemptsMade: 2,
    finishedOn: 1757700000000,
    timestamp: 1757700000000,
  };
  const jobs = await svc(makeQueueMock({ getFailed: async () => [fakeJob] })).getFailedJobs(10);
  assert.ok(!jobs[0].failedReason.includes('http://'));
  assert.ok(!jobs[0].failedReason.includes('10.0.0.5'));
  assert.ok(jobs[0].failedReason.includes('[REDACTED_URL]'));
  assert.ok(jobs[0].failedReason.includes('[REDACTED_IP]'));
});

// ---------------------------------------------------------------------------
// retryFailedJob
// ---------------------------------------------------------------------------

test('retryFailedJob throws ServiceUnavailableException when queue is down', async () => {
  await assert.rejects(() => svc(null).retryFailedJob('job-1'), ServiceUnavailableException);
});

test('retryFailedJob throws NotFoundException for missing job', async () => {
  const queue = makeQueueMock({ getJob: async () => null });
  await assert.rejects(() => svc(queue).retryFailedJob('nonexistent'), NotFoundException);
});

test('retryFailedJob throws ConflictException for active job', async () => {
  const job = { getState: async () => 'active', retry: async () => {} };
  const queue = makeQueueMock({ getJob: async () => job });
  await assert.rejects(() => svc(queue).retryFailedJob('job-1'), ConflictException);
});

test('retryFailedJob throws ConflictException for completed job', async () => {
  const job = { getState: async () => 'completed', retry: async () => {} };
  const queue = makeQueueMock({ getJob: async () => job });
  await assert.rejects(() => svc(queue).retryFailedJob('job-1'), ConflictException);
});

test('retryFailedJob calls job.retry() and returns waiting for failed SOURCING job', async () => {
  let retried = false;
  const job = {
    getState: async () => 'failed',
    retry: async () => { retried = true; },
    data: { orderId: 'o-1' },
  };
  const queue = makeQueueMock({ getJob: async () => job });
  const db = makeDbMock([], [{ status: 'SOURCING' }]); // order still SOURCING
  const result = await svc(queue, db).retryFailedJob('job-1');

  assert.strictEqual(retried, true);
  assert.strictEqual(result.state, 'waiting');
  assert.strictEqual(result.jobId, 'job-1');
});

test('retryFailedJob throws JOB_NOT_RETRYABLE when order is already REFUNDED', async () => {
  const job = {
    getState: async () => 'failed',
    retry: async () => {},
    data: { orderId: 'o-refunded' },
  };
  const queue = makeQueueMock({ getJob: async () => job });
  const db = makeDbMock([], [{ status: 'REFUNDED' }]);
  const err = await svc(queue, db).retryFailedJob('job-1').catch((e) => e);
  assert.strictEqual(err instanceof ConflictException, true);
  assert.strictEqual((err as any).getResponse?.().errorCode, 'JOB_NOT_RETRYABLE');
});

test('retryFailedJob maps JobNotInState race error to ConflictException', async () => {
  const job = {
    getState: async () => 'failed',
    retry: async () => { throw new Error('Job job-1 is not in the failed state. retry'); },
    data: { orderId: 'o-1' },
  };
  const queue = makeQueueMock({ getJob: async () => job });
  const db = makeDbMock([], [{ status: 'SOURCING' }]);
  await assert.rejects(() => svc(queue, db).retryFailedJob('job-1'), ConflictException);
});

test('retryFailedJob re-throws infrastructure errors instead of masking as 409', async () => {
  const job = {
    getState: async () => 'failed',
    retry: async () => { throw new Error('ECONNREFUSED: Redis connection lost'); },
    data: { orderId: 'o-1' },
  };
  const queue = makeQueueMock({ getJob: async () => job });
  const db = makeDbMock([], [{ status: 'SOURCING' }]);
  await assert.rejects(
    () => svc(queue, db).retryFailedJob('job-1'),
    (err: any) => err.message.includes('ECONNREFUSED'),
  );
});
