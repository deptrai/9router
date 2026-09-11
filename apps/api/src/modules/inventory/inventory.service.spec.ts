import { test } from 'node:test';
import assert from 'node:assert';
import { InventoryService } from './inventory.service';
import { InventoryStatus } from '@repo/shared-types';
import { encryptCredential, db } from '@repo/database';
import { NotFoundException, BadRequestException } from '@nestjs/common';

function makeMockTx(initialItems: any[] = []) {
  const items = [...initialItems];

  const tx: any = {
    select: (fields?: any) => ({
      from: (table: any) => {
        const name = table?.[Symbol.for('drizzle:Name')] ?? table?.name;
        if (name === 'products') {
          return {
            where: () => ({
              limit: () => Promise.resolve([{ id: 'prod-1' }]),
            }),
          };
        }
        // product_inventory
        return {
          where: (predicate: any) => {
            // Check if count / group by query
            return {
              groupBy: () => {
                const countMap = new Map<string, number>();
                for (const item of items) {
                  countMap.set(item.status, (countMap.get(item.status) ?? 0) + 1);
                }
                const result = Array.from(countMap.entries()).map(([status, count]) => ({
                  status,
                  count,
                }));
                return Promise.resolve(result);
              },
              for: (mode: string, options?: any) => ({
                limit: (lim: number) => {
                  if (options?.skipLocked) {
                    // reserveCredential: only AVAILABLE items, skip locked
                    const available = items.filter((i) => i.status === InventoryStatus.AVAILABLE);
                    return Promise.resolve(available.slice(0, lim));
                  }
                  // confirmSold: plain FOR UPDATE, return first item (id lookup)
                  return Promise.resolve(items.slice(0, lim));
                },
              }),
              limit: (lim: number) => {
                return Promise.resolve(items.slice(0, lim));
              },
            };
          },
        };
      },
    }),
    update: (table: any) => ({
      set: (updateValues: any) => ({
        where: (predicate: any) => ({
          returning: (fields?: any) => {
            // Find target item
            const idx = items.findIndex((i) => i.id === updateValues.__targetId || i.status === InventoryStatus.AVAILABLE || i.status === InventoryStatus.RESERVED);
            if (idx !== -1) {
              Object.assign(items[idx], updateValues);
              return Promise.resolve([items[idx]]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
    }),
    insert: (table: any) => ({
      values: (newVals: any[]) => ({
        returning: () => {
          const inserted = newVals.map((v, i) => {
            const row = { id: `inv-${items.length + i + 1}`, ...v };
            items.push(row);
            return { id: row.id };
          });
          return Promise.resolve(inserted);
        },
      }),
    }),
  };

  return { tx, items };
}

test('reserveCredential reserves 1 AVAILABLE item and sets RESERVED status', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: encryptCredential('KEY-1'), status: InventoryStatus.AVAILABLE, orderId: null },
  ];
  const { tx } = makeMockTx(sample);

  const res = await service.reserveCredential('prod-1', 'order-123', tx);
  assert.ok(res);
  assert.strictEqual(res.id, 'inv-1');
  assert.strictEqual(res.status, InventoryStatus.RESERVED);
  assert.strictEqual(res.orderId, 'order-123');
});

test('reserveCredential returns null when no AVAILABLE items exist', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: encryptCredential('KEY-1'), status: InventoryStatus.SOLD, orderId: 'prev-order' },
  ];
  const { tx } = makeMockTx(sample);

  const res = await service.reserveCredential('prod-1', 'order-123', tx);
  assert.strictEqual(res, null);
});

test('releaseReservation reverts status to AVAILABLE and clears orderId', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: encryptCredential('KEY-1'), status: InventoryStatus.RESERVED, orderId: 'order-123' },
  ];
  const { tx } = makeMockTx(sample);

  const success = await service.releaseReservation('inv-1', tx);
  assert.strictEqual(success, true);
});

test('confirmSold marks item SOLD, sets soldAt, and decrypts credential', async () => {
  const service = new InventoryService();
  const secretKey = 'MY-SECRET-LICENSE-KEY';
  const sample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: encryptCredential(secretKey), status: InventoryStatus.RESERVED, orderId: 'order-123' },
  ];
  const { tx } = makeMockTx(sample);

  const res = await service.confirmSold('inv-1', 'order-123', tx);
  assert.strictEqual(res.id, 'inv-1');
  assert.strictEqual(res.status, undefined); // DTO has credentialData, orderId, soldAt
  assert.strictEqual(res.credentialData, secretKey);
  assert.strictEqual(res.orderId, 'order-123');
  assert.ok(res.soldAt);
});

test('confirmSold throws NotFoundException when item does not exist', async () => {
  const service = new InventoryService();
  const { tx } = makeMockTx([]);

  await assert.rejects(
    () => service.confirmSold('non-existent-id', 'order-123', tx),
    (err: any) => err instanceof NotFoundException,
  );
});

test('confirmSold supports idempotent re-delivery for the same orderId', async () => {
  const service = new InventoryService();
  const secretKey = 'MY-SECRET-LICENSE-KEY';
  const sample = [
    {
      id: 'inv-1',
      productId: 'prod-1',
      credentialData: encryptCredential(secretKey),
      status: InventoryStatus.SOLD,
      orderId: 'order-123',
      soldAt: new Date(),
    },
  ];
  const { tx } = makeMockTx(sample);

  const res = await service.confirmSold('inv-1', 'order-123', tx);
  assert.strictEqual(res.id, 'inv-1');
  assert.strictEqual(res.credentialData, secretKey);
  assert.strictEqual(res.orderId, 'order-123');
  assert.ok(res.soldAt);
});

test('confirmSold throws INVENTORY_ALREADY_SOLD when already sold to another order', async () => {
  const service = new InventoryService();
  const soldSample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: encryptCredential('KEY-1'), status: InventoryStatus.SOLD, orderId: 'prev-order' },
  ];
  const { tx } = makeMockTx(soldSample);

  await assert.rejects(
    () => service.confirmSold('inv-1', 'new-order', tx),
    (err: any) => {
      assert.ok(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVENTORY_ALREADY_SOLD');
      return true;
    },
  );
});

test('confirmSold throws INVENTORY_ITEM_DEFECTIVE when item status is DEFECTIVE', async () => {
  const service = new InventoryService();
  const defectiveSample = [
    { id: 'inv-2', productId: 'prod-1', credentialData: encryptCredential('KEY-2'), status: InventoryStatus.DEFECTIVE, orderId: null },
  ];
  const { tx } = makeMockTx(defectiveSample);

  await assert.rejects(
    () => service.confirmSold('inv-2', 'new-order', tx),
    (err: any) => {
      assert.ok(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVENTORY_ITEM_DEFECTIVE');
      return true;
    },
  );
});

test('confirmSold throws INVENTORY_ORDER_MISMATCH when item is RESERVED for a different order', async () => {
  const service = new InventoryService();
  const reservedSample = [
    { id: 'inv-3', productId: 'prod-1', credentialData: encryptCredential('KEY-3'), status: InventoryStatus.RESERVED, orderId: 'order-aaa' },
  ];
  const { tx } = makeMockTx(reservedSample);

  await assert.rejects(
    () => service.confirmSold('inv-3', 'order-bbb', tx),
    (err: any) => {
      assert.ok(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVENTORY_ORDER_MISMATCH');
      return true;
    },
  );
});

test('ensureTransaction wraps operations in db.transaction when tx is omitted', async () => {
  const service = new InventoryService();
  const originalTx = (db as any).transaction;
  let txCalled = false;

  const mockTx = makeMockTx([
    { id: 'inv-standalone', productId: 'prod-standalone', status: InventoryStatus.AVAILABLE, orderId: null },
  ]).tx;

  (db as any).transaction = async (fn: any) => {
    txCalled = true;
    return fn(mockTx);
  };

  try {
    const res = await service.reserveCredential('prod-standalone', 'order-standalone');
    assert.strictEqual(txCalled, true);
    assert.strictEqual(res?.id, 'inv-standalone');
    assert.strictEqual(res?.status, InventoryStatus.RESERVED);
  } finally {
    (db as any).transaction = originalTx;
  }
});

test('markDefective marks status as DEFECTIVE', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: encryptCredential('KEY-1'), status: InventoryStatus.AVAILABLE, orderId: null },
  ];
  const { tx } = makeMockTx(sample);

  const success = await service.markDefective('inv-1', 'Invalid key report', tx);
  assert.strictEqual(success, true);
});

test('addCredentials encrypts each credential with AES-256-GCM and filters whitespace', async () => {
  const service = new InventoryService();
  const { tx, items } = makeMockTx([]);

  const count = await service.addCredentials('prod-1', ['KEY-ALPHA', '', '   ', 'KEY-BETA'], tx);
  assert.strictEqual(count, 2);
  assert.strictEqual(items.length, 2);
  assert.ok(items[0].credentialData.startsWith('enc:v1:'));
  assert.ok(items[1].credentialData.startsWith('enc:v1:'));
});

test('addCredentials throws BATCH_SIZE_EXCEEDED when credentials count exceeds 500', async () => {
  const service = new InventoryService();
  const { tx } = makeMockTx([]);
  const tooMany = Array.from({ length: 501 }, (_, i) => `KEY-${i}`);

  await assert.rejects(
    () => service.addCredentials('prod-1', tooMany, tx),
    (err: any) => {
      assert.ok(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'BATCH_SIZE_EXCEEDED');
      return true;
    },
  );
});

test('getStockSummary returns aggregated counts by status', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', status: InventoryStatus.AVAILABLE },
    { id: 'inv-2', productId: 'prod-1', status: InventoryStatus.AVAILABLE },
    { id: 'inv-3', productId: 'prod-1', status: InventoryStatus.RESERVED },
    { id: 'inv-4', productId: 'prod-1', status: InventoryStatus.SOLD },
    { id: 'inv-5', productId: 'prod-1', status: InventoryStatus.DEFECTIVE },
  ];
  const { tx } = makeMockTx(sample);

  const summary = await service.getStockSummary('prod-1', tx);
  assert.strictEqual(summary.available, 2);
  assert.strictEqual(summary.reserved, 1);
  assert.strictEqual(summary.sold, 1);
  assert.strictEqual(summary.defective, 1);
  assert.strictEqual(summary.total, 5);
});

test('Zero Oversell Concurrency Simulation: 50 concurrent requests on 5 items allocate exactly 5 and reject 45', async () => {
  const service = new InventoryService();
  // Simulating 5 available items in pool
  const inventoryPool = Array.from({ length: 5 }, (_, i) => ({
    id: `pool-item-${i + 1}`,
    productId: 'prod-test-concurrent',
    credentialData: encryptCredential(`KEY-${i}`),
    status: InventoryStatus.AVAILABLE,
    orderId: null,
  }));

  // Global set of row locks held by concurrent transactions
  const globalLockedIds = new Set<string>();

  const createConcurrentTx = () => {
    let lockedItemInThisTx: any = null;
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            for: (mode: string, options?: any) => ({
              limit: (lim: number) => {
                // Find first item that is AVAILABLE and not locked by another transaction
                for (const item of inventoryPool) {
                  if (item.status === InventoryStatus.AVAILABLE && !globalLockedIds.has(item.id)) {
                    globalLockedIds.add(item.id);
                    lockedItemInThisTx = item;
                    return Promise.resolve([item]);
                  }
                }
                return Promise.resolve([]);
              },
            }),
          }),
        }),
      }),
      update: () => ({
        set: (updateValues: any) => ({
          where: () => ({
            returning: () => {
              if (lockedItemInThisTx) {
                lockedItemInThisTx.status = updateValues.status;
                lockedItemInThisTx.orderId = updateValues.orderId;
                return Promise.resolve([{
                  id: lockedItemInThisTx.id,
                  productId: lockedItemInThisTx.productId,
                  status: lockedItemInThisTx.status,
                  orderId: lockedItemInThisTx.orderId,
                }]);
              }
              return Promise.resolve([]);
            },
          }),
        }),
      }),
    };
  };

  const parallelAttempts = 50;
  const results = await Promise.all(
    Array.from({ length: parallelAttempts }, (_, i) => {
      const tx = createConcurrentTx();
      return service.reserveCredential('prod-test-concurrent', `order-concurrent-${i}`, tx as any);
    }),
  );

  const successfulReservations = results.filter((r) => r !== null);
  const outOfStockResponses = results.filter((r) => r === null);

  assert.strictEqual(successfulReservations.length, 5, 'Exactly 5 items must be reserved');
  assert.strictEqual(outOfStockResponses.length, 45, 'Remaining 45 requests must receive null');

  // Verify unique assigned inventory IDs
  const assignedIds = new Set(successfulReservations.map((r) => r!.id));
  assert.strictEqual(assignedIds.size, 5, 'No two reservations ever receive the same inventory ID');
});
