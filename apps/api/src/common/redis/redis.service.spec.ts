import { test } from 'node:test';
import assert from 'node:assert';
import { RedisService, RedisUnavailableError } from './redis.service';
import { ExecutionError, ResourceLockedError } from 'redlock';

function makeFakeClient() {
  const calls: string[] = [];
  return {
    calls,
    status: 'wait',
    connect: async () => { calls.push('connect'); },
    ping: async () => { calls.push('ping'); return 'PONG'; },
    disconnect: () => { calls.push('disconnect'); },
    on: () => {},
  } as any;
}

test('RedisService.withLock returns routine result on success', async (t) => {
  const fakeClient = makeFakeClient();
  const service = new RedisService(fakeClient);
  t.after(() => service.onModuleDestroy());

  const mockRedlock = {
    using: async (_resources: any, _duration: any, routine: any) => {
      return routine({ aborted: false } as any);
    },
  } as any;
  (service as any).redlock = mockRedlock;

  const result = await service.withLock('lock:test:1', 5000, async () => 'done');
  assert.strictEqual(result, 'done');
});

test('RedisService.withLock supports array of resources', async (t) => {
  const fakeClient = makeFakeClient();
  const service = new RedisService(fakeClient);
  t.after(() => service.onModuleDestroy());

  const capturedResources: string[] = [];
  const mockRedlock = {
    using: async (resources: any, _duration: any, routine: any) => {
      capturedResources.push(...resources);
      return routine({ aborted: false } as any);
    },
  } as any;
  (service as any).redlock = mockRedlock;

  await service.withLock(['lock:a', 'lock:b'], 3000, async () => 'ok');
  assert.deepStrictEqual(capturedResources, ['lock:a', 'lock:b']);
});

test('RedisService.withLock propagates Redis unavailable as thrown', async (t) => {
  const fakeClient = makeFakeClient();
  const service = new RedisService(fakeClient);
  t.after(() => service.onModuleDestroy());

  const mockRedlock = {
    using: async () => {
      throw new Error('Connection refused');
    },
  } as any;
  (service as any).redlock = mockRedlock;

  await assert.rejects(
    () => service.withLock('lock:test:2', 5000, async () => 'done'),
    (err: any) => err.message === 'Connection refused',
  );
});

test('RedisService.withLock throws ExecutionError for busy lock', async (t) => {
  const fakeClient = makeFakeClient();
  const service = new RedisService(fakeClient);
  t.after(() => service.onModuleDestroy());

  const resourceLocked = new ResourceLockedError('The operation was applied to: 0 of the 1 requested resources.');
  const execError = new ExecutionError('busy', [Promise.resolve({}) as any]);
  (execError as any).attempts = [{ vote: 'against', error: resourceLocked }] as any;

  const mockRedlock = {
    using: async () => {
      throw execError;
    },
  } as any;
  (service as any).redlock = mockRedlock;

  await assert.rejects(
    () => service.withLock('lock:test:3', 5000, async () => 'done'),
    (err: any) => err instanceof ExecutionError,
  );
});

test('RedisService.withLock propagates routine errors without swallowing', async (t) => {
  const fakeClient = makeFakeClient();
  const service = new RedisService(fakeClient);
  t.after(() => service.onModuleDestroy());

  const businessErr = new Error('business failure');
  const mockRedlock = {
    using: async (_resources: any, _duration: any, routine: any) => {
      return routine({ aborted: false } as any);
    },
  } as any;
  (service as any).redlock = mockRedlock;

  await assert.rejects(
    () => service.withLock('lock:test:4', 5000, async () => { throw businessErr; }),
    (err: any) => err === businessErr,
  );
});

test('RedisService.withLock throws RedisUnavailableError when signal aborted before routine', async (t) => {
  const fakeClient = makeFakeClient();
  const service = new RedisService(fakeClient);
  t.after(() => service.onModuleDestroy());

  const mockRedlock = {
    using: async (_resources: any, _duration: any, routine: any) => {
      return routine({ aborted: true, error: new RedisUnavailableError('lock lost') } as any);
    },
  } as any;
  (service as any).redlock = mockRedlock;

  let routineRan = false;
  await assert.rejects(
    () => service.withLock('lock:test:5', 5000, async () => { routineRan = true; return 'x'; }),
    (err: any) => err instanceof RedisUnavailableError,
  );
  assert.strictEqual(routineRan, false);
});

test('RedisService.withLock throws when signal aborts during routine execution', async (t) => {
  const fakeClient = makeFakeClient();
  const service = new RedisService(fakeClient);
  t.after(() => service.onModuleDestroy());

  const signal = { aborted: false, error: undefined as any };
  const mockRedlock = {
    using: async (_resources: any, _duration: any, routine: any) => routine(signal),
  } as any;
  (service as any).redlock = mockRedlock;

  await assert.rejects(
    () => service.withLock('lock:test:6', 5000, async () => {
      // simulate lock loss while routine runs
      signal.aborted = true;
      signal.error = new RedisUnavailableError('lock expired mid-flight');
      return 'committed';
    }),
    (err: any) => err instanceof RedisUnavailableError && err.message === 'lock expired mid-flight',
  );
});

test('RedisService.isHealthy returns true when client reachable', async (t) => {
  const fakeClient = makeFakeClient();
  const service = new RedisService(fakeClient);
  t.after(() => service.onModuleDestroy());

  const healthy = await service.isHealthy();
  assert.strictEqual(healthy, true);
  assert.deepStrictEqual(fakeClient.calls, ['connect', 'ping']);
});

test('RedisService.isHealthy returns false when ping fails', async (t) => {
  const fakeClient = makeFakeClient();
  fakeClient.status = 'ready';
  fakeClient.ping = async () => { throw new Error('timeout'); };
  const service = new RedisService(fakeClient);
  t.after(() => service.onModuleDestroy());

  const healthy = await service.isHealthy();
  assert.strictEqual(healthy, false);
});

test('RedisService.onModuleDestroy disconnects client', async (t) => {
  const fakeClient = makeFakeClient();
  const service = new RedisService(fakeClient);
  await service.onModuleDestroy();
  assert.ok(fakeClient.calls.includes('disconnect'));
});
