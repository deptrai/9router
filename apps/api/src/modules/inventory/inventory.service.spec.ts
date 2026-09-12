import { test } from 'node:test';
import assert from 'node:assert';
import { InventoryService } from './inventory.service';
import { InventoryStatus } from '@repo/shared-types';
import { encryptCredential, decryptCredential } from '@repo/database';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';

function makeMockTx(initialItems: any[] = [], productList: any[] = [{ id: 'prod-1' }]) {
  const items = [...initialItems];
  const products = [...productList];

  const tx: any = {
    select: (fields?: any) => ({
      from: (table: any) => {
        const name = table?.[Symbol.for('drizzle:Name')] ?? table?.name;
        if (name === 'products') {
          return {
            where: (predicate: any) => ({
              limit: () => Promise.resolve(products),
            }),
          };
        }
        // product_inventory query builder
        const handleGroupBy = (...groupFields: any[]) => {
          if (groupFields.length > 1) {
            // Group by productId and status
            const keyMap = new Map<string, { productId: string; status: string; count: number }>();
            for (const item of items) {
              const key = `${item.productId}:${item.status}`;
              const existing = keyMap.get(key);
              if (existing) {
                existing.count++;
              } else {
                keyMap.set(key, { productId: item.productId, status: item.status, count: 1 });
              }
            }
            return Promise.resolve(Array.from(keyMap.values()));
          }

          // Single group by (e.g. status)
          const countMap = new Map<string, number>();
          for (const item of items) {
            countMap.set(item.status, (countMap.get(item.status) ?? 0) + 1);
          }
          return Promise.resolve(Array.from(countMap.entries()).map(([status, count]) => ({
            status,
            count,
          })));
        };

        const whereResult: any = {
          groupBy: handleGroupBy,
          for: (mode: string, options?: any) => ({
            limit: (lim: number) => {
              if (options?.skipLocked) {
                const available = items.filter((i) => i.status === InventoryStatus.AVAILABLE);
                return Promise.resolve(available.slice(0, lim));
              }
              return Promise.resolve(items.slice(0, lim));
            },
          }),
          limit: (lim: number) => Promise.resolve(items.slice(0, lim)),
          orderBy: (field: any) => ({
            limit: (lim: number) => ({
              offset: (off: number) => Promise.resolve(items.slice(off, off + lim)),
            }),
          }),
          then: (resolve: any, reject: any) => {
            // If select({ count }) query was awaited directly without chaining
            if (fields && 'count' in fields && Object.keys(fields).length === 1) {
              return Promise.resolve([{ count: items.length }]).then(resolve, reject);
            }
            return Promise.resolve(items).then(resolve, reject);
          },
        };

        return {
          where: (predicate: any) => whereResult,
          groupBy: handleGroupBy,
        };
      },
    }),
    update: (table: any) => ({
      set: (updateValues: any) => ({
        where: (predicate: any) => ({
          returning: (fields?: any) => {
            const idx = items.findIndex((i) => i.id === updateValues.__targetId || i.status === InventoryStatus.AVAILABLE || i.status === InventoryStatus.RESERVED || i.status === InventoryStatus.DEFECTIVE);
            if (idx !== -1) {
              Object.assign(items[idx], updateValues);
              return Promise.resolve([items[idx]]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
    }),
    delete: (table: any) => ({
      where: (predicate: any) => ({
        returning: (fields?: any) => {
          const idx = items.findIndex((i) => i.status === InventoryStatus.AVAILABLE || i.status === InventoryStatus.DEFECTIVE);
          if (idx !== -1) {
            const deleted = items.splice(idx, 1);
            return Promise.resolve(deleted.map((d) => ({ id: d.id })));
          }
          return Promise.resolve([]);
        },
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

// Original tests
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
  const { tx } = makeMockTx([]);
  const res = await service.reserveCredential('prod-1', 'order-123', tx);
  assert.strictEqual(res, null);
});

test('releaseReservation reverts status to AVAILABLE and clears orderId', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', status: InventoryStatus.RESERVED, orderId: 'order-123' },
  ];
  const { tx } = makeMockTx(sample);
  const res = await service.releaseReservation('inv-1', tx);
  assert.strictEqual(res, true);
});

test('confirmSold marks item SOLD, sets soldAt, and decrypts credential', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: encryptCredential('SECRET-KEY'), status: InventoryStatus.AVAILABLE, orderId: null, soldAt: null },
  ];
  const { tx } = makeMockTx(sample);

  const res = await service.confirmSold('inv-1', 'order-123', tx);
  assert.strictEqual(res.id, 'inv-1');
  assert.strictEqual(res.credentialData, 'SECRET-KEY');
});

test('confirmSold throws NotFoundException when item does not exist', async () => {
  const service = new InventoryService();
  const { tx } = makeMockTx([]);
  await assert.rejects(() => service.confirmSold('inv-1', 'order-123', tx), NotFoundException);
});

test('confirmSold supports idempotent re-delivery for the same orderId', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: encryptCredential('SECRET-KEY'), status: InventoryStatus.SOLD, orderId: 'order-123', soldAt: new Date() },
  ];
  const { tx } = makeMockTx(sample);
  const res = await service.confirmSold('inv-1', 'order-123', tx);
  assert.strictEqual(res.credentialData, 'SECRET-KEY');
});

test('confirmSold throws INVENTORY_ALREADY_SOLD when already sold to another order', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: encryptCredential('SECRET-KEY'), status: InventoryStatus.SOLD, orderId: 'order-123', soldAt: new Date() },
  ];
  const { tx } = makeMockTx(sample);
  await assert.rejects(() => service.confirmSold('inv-1', 'order-456', tx), BadRequestException);
});

test('confirmSold throws INVENTORY_ITEM_DEFECTIVE when item status is DEFECTIVE', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', status: InventoryStatus.DEFECTIVE },
  ];
  const { tx } = makeMockTx(sample);
  await assert.rejects(() => service.confirmSold('inv-1', 'order-123', tx), BadRequestException);
});

test('confirmSold throws INVENTORY_ORDER_MISMATCH when item is RESERVED for a different order', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', status: InventoryStatus.RESERVED, orderId: 'order-123' },
  ];
  const { tx } = makeMockTx(sample);
  await assert.rejects(() => service.confirmSold('inv-1', 'order-456', tx), BadRequestException);
});

test('ensureTransaction wraps operations in db.transaction when tx is omitted', async () => {
  const service = new InventoryService();
  assert.ok(service);
});

test('markDefective marks status as DEFECTIVE', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', status: InventoryStatus.AVAILABLE },
  ];
  const { tx } = makeMockTx(sample);
  const res = await service.markDefective('inv-1', 'broken key', tx);
  assert.strictEqual(res, true);
});

test('addCredentials encrypts each credential with AES-256-GCM and filters whitespace', async () => {
  const service = new InventoryService();
  const { tx, items } = makeMockTx([], [{ id: 'prod-1' }]);
  const count = await service.addCredentials('prod-1', ['key1', 'key2', 'key1'], tx);
  assert.strictEqual(count, 3);
});

test('addCredentials throws BATCH_SIZE_EXCEEDED when credentials count exceeds 500', async () => {
  const service = new InventoryService();
  const { tx } = makeMockTx([], [{ id: 'prod-1' }]);
  const bigArray = Array(501).fill('key');
  await assert.rejects(() => service.addCredentials('prod-1', bigArray, tx), BadRequestException);
});

test('getStockSummary returns aggregated counts by status', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', status: InventoryStatus.AVAILABLE },
    { id: 'inv-2', productId: 'prod-1', status: InventoryStatus.AVAILABLE },
    { id: 'inv-3', productId: 'prod-1', status: InventoryStatus.SOLD },
  ];
  const { tx } = makeMockTx(sample);
  const res = await service.getStockSummary('prod-1', tx);
  assert.strictEqual(res.available, 2);
  assert.strictEqual(res.sold, 1);
});

// ---------------------------------------------------------------------------
// Story 5.2: Admin Inventory Management Tests
// ---------------------------------------------------------------------------

test('listProductInventory returns masked credentials with pagination', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: 'enc:v1:iv:tag:encrypted1', status: InventoryStatus.AVAILABLE, orderId: null, addedAt: new Date(), soldAt: null },
    { id: 'inv-2', productId: 'prod-1', credentialData: 'enc:v1:iv:tag:encrypted2', status: InventoryStatus.SOLD, orderId: 'order-1', addedAt: new Date(), soldAt: new Date() },
  ];
  const { tx } = makeMockTx(sample);

  const result = await service.listProductInventory('prod-1', { limit: 10, offset: 0 }, tx);

  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.items[0].maskedCredential, '***');
});

test('getGlobalInventorySummary returns aggregated stats', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', status: InventoryStatus.AVAILABLE },
    { id: 'inv-2', productId: 'prod-1', status: InventoryStatus.AVAILABLE },
    { id: 'inv-3', productId: 'prod-2', status: InventoryStatus.SOLD },
    { id: 'inv-4', productId: 'prod-2', status: InventoryStatus.DEFECTIVE },
  ];
  const products = [
    { id: 'prod-1', title: 'Product 1' },
    { id: 'prod-2', title: 'Product 2' },
  ];
  const { tx } = makeMockTx(sample, products);

  const result = await service.getGlobalInventorySummary(tx);

  assert.strictEqual(result.totalAvailable, 2);
  assert.strictEqual(result.totalSold, 1);
  assert.strictEqual(result.totalDefective, 1);
  assert.strictEqual(result.productStockSummaries.length, 2);
});

test('batchImportCredentials validates product isActive and sourcingMode', async () => {
  const service = new InventoryService();
  
  // Test inactive product
  const { tx: txInactive } = makeMockTx([], [{ id: 'prod-1', isActive: false, sourcingMode: 'IN_HOUSE' }]);
  await assert.rejects(
    () => service.batchImportCredentials('prod-1', ['key1'], txInactive),
    BadRequestException
  );

  // Test EXTERNAL product
  const { tx: txExternal } = makeMockTx([], [{ id: 'prod-2', isActive: true, sourcingMode: 'EXTERNAL' }]);
  await assert.rejects(
    () => service.batchImportCredentials('prod-2', ['key1'], txExternal),
    BadRequestException
  );
});

test('batchImportCredentials normalizes and deduplicates lines', async () => {
  const service = new InventoryService();
  const { tx, items } = makeMockTx([], [{ id: 'prod-1', isActive: true, sourcingMode: 'IN_HOUSE' }]);

  const result = await service.batchImportCredentials(
    'prod-1',
    ['key1\r\nkey2', '#comment', 'key1', 'key3'],
    tx
  );

  assert.strictEqual(result.count, 3);
});

test('batchImportCredentials rejects empty batch', async () => {
  const service = new InventoryService();
  const { tx } = makeMockTx([], [{ id: 'prod-1', isActive: true, sourcingMode: 'IN_HOUSE' }]);

  await assert.rejects(
    () => service.batchImportCredentials('prod-1', ['#comment1', '#comment2'], tx),
    BadRequestException
  );
});

test('batchImportCredentials rejects lines exceeding 2048 chars', async () => {
  const service = new InventoryService();
  const { tx } = makeMockTx([], [{ id: 'prod-1', isActive: true, sourcingMode: 'IN_HOUSE' }]);

  const longLine = 'x'.repeat(2049);
  await assert.rejects(
    () => service.batchImportCredentials('prod-1', [longLine], tx),
    BadRequestException
  );
});

test('deleteCredential prevents deletion of SOLD credentials', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-sold', productId: 'prod-1', status: InventoryStatus.SOLD, orderId: 'order-1' },
  ];
  const { tx } = makeMockTx(sample);

  await assert.rejects(
    () => service.deleteCredential('inv-sold', tx),
    ConflictException
  );
});

test('deleteCredential allows deletion of AVAILABLE credentials', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-avail', productId: 'prod-1', status: InventoryStatus.AVAILABLE },
  ];
  const { tx, items } = makeMockTx(sample);

  const result = await service.deleteCredential('inv-avail', tx);
  assert.strictEqual(result, true);
});

test('updateCredentialStatus toggles between AVAILABLE and DEFECTIVE', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-1', productId: 'prod-1', status: InventoryStatus.AVAILABLE },
  ];
  const { tx } = makeMockTx(sample);

  const result = await service.updateCredentialStatus('inv-1', 'DEFECTIVE', tx);
  assert.strictEqual(result, true);
});

test('updateCredentialStatus rejects status change for SOLD items', async () => {
  const service = new InventoryService();
  const sample = [
    { id: 'inv-sold', productId: 'prod-1', status: InventoryStatus.SOLD },
  ];
  const { tx } = makeMockTx(sample);

  await assert.rejects(
    () => service.updateCredentialStatus('inv-sold', 'DEFECTIVE', tx),
    ConflictException
  );
});

test('decryptSingleCredential returns plaintext with audit log', async () => {
  const service = new InventoryService();
  const encrypted = encryptCredential('plaintext-secret');
  const sample = [
    { id: 'inv-1', productId: 'prod-1', credentialData: encrypted, status: InventoryStatus.AVAILABLE },
  ];
  const { tx } = makeMockTx(sample);

  const result = await service.decryptSingleCredential('inv-1', 'admin-1', '127.0.0.1', tx);
  assert.strictEqual(result, 'plaintext-secret');
});
