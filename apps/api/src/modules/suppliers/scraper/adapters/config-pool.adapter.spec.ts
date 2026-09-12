import { test } from 'node:test';
import assert from 'node:assert';
import { ConfigPoolAdapter } from './config-pool.adapter';
import { SupplierTerminalError } from './supplier-adapter';

test('ConfigPoolAdapter.purchase returns pool[0] without mutating credentials', async () => {
  const adapter = new ConfigPoolAdapter();
  const mockSupplier = {
    id: 'sup-1',
    name: 'Pool Supplier',
    type: 'CONFIG_POOL',
    targetUrl: null,
    configCredentials: {
      credentialPool: ['KEY-A', 'KEY-B', 'KEY-C'],
    },
    markupPercentage: '0.00',
    markupFixedVnd: '0.00',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const res = await adapter.purchase({} as any, mockSupplier as any);
  assert.strictEqual(res.credential, 'KEY-A');
  assert.strictEqual(res.externalOrderId, 'config-pool');
  assert.strictEqual(res.cost, undefined);

  // Supplier pool should not be mutated in purchase()
  const pool = (mockSupplier.configCredentials as any).credentialPool;
  assert.deepStrictEqual(pool, ['KEY-A', 'KEY-B', 'KEY-C']);
});

test('ConfigPoolAdapter.purchase throws SupplierTerminalError when credentialPool is empty or invalid', async () => {
  const adapter = new ConfigPoolAdapter();

  await assert.rejects(
    async () => {
      await adapter.purchase(
        {} as any,
        { configCredentials: { credentialPool: [] } } as any,
      );
    },
    (err: any) => {
      assert(err instanceof SupplierTerminalError);
      assert.strictEqual(err.message, 'CREDENTIAL_POOL_EMPTY');
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await adapter.purchase({} as any, { configCredentials: null } as any);
    },
    (err: any) => {
      assert(err instanceof SupplierTerminalError);
      assert.strictEqual(err.message, 'CREDENTIAL_POOL_EMPTY');
      return true;
    },
  );
});

test('ConfigPoolAdapter.commit re-reads FOR UPDATE and shifts the credential pool within transaction', async () => {
  const adapter = new ConfigPoolAdapter();

  let updateSetPayload: any = null;
  const mockTx: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async (_lock: string) => [
            {
              id: 'sup-1',
              configCredentials: {
                otherField: 'val',
                credentialPool: ['KEY-1', 'KEY-2'],
              },
            },
          ],
        }),
      }),
    }),
    update: () => ({
      set: (payload: any) => {
        updateSetPayload = payload;
        return {
          where: async () => {},
        };
      },
    }),
  };

  const result = await adapter.commit(
    'sup-1',
    { credential: 'KEY-1' },
    mockTx,
  );

  assert.strictEqual(result.credential, 'KEY-1');
  assert.strictEqual(result.externalOrderId, 'config-pool');
  assert.strictEqual(result.cost, undefined);

  assert(updateSetPayload);
  assert.deepStrictEqual(updateSetPayload.configCredentials.credentialPool, [
    'KEY-2',
  ]);
  assert.strictEqual(updateSetPayload.configCredentials.otherField, 'val');
});

test('ConfigPoolAdapter.commit throws SupplierTerminalError if pool is empty in DB', async () => {
  const adapter = new ConfigPoolAdapter();

  const mockTx: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async (_lock: string) => [
            {
              id: 'sup-1',
              configCredentials: {
                credentialPool: [],
              },
            },
          ],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {},
      }),
    }),
  };

  await assert.rejects(
    async () => {
      await adapter.commit('sup-1', { credential: 'KEY-1' }, mockTx);
    },
    (err: any) => {
      assert(err instanceof SupplierTerminalError);
      assert.strictEqual(err.message, 'CREDENTIAL_POOL_EMPTY');
      return true;
    },
  );
});
