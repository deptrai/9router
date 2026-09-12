import { test } from 'node:test';
import assert from 'node:assert';
import { AdminInventoryController } from './admin-inventory.controller';
import { InventoryService } from './inventory.service';
import { InventoryStatus } from '@repo/shared-types';

test('AdminInventoryController has AdminRoleGuard applied at class level', () => {
  const guards = Reflect.getMetadata('__guards__', AdminInventoryController);
  assert.ok(guards, 'Guards should be applied');
  assert.strictEqual(guards.length, 1);
  assert.strictEqual(guards[0].name, 'AdminRoleGuard');
});

test('AdminInventoryController.getGlobalSummary returns global summary', async () => {
  const mockService = {
    getGlobalInventorySummary: async () => ({
      totalAvailable: 10,
      totalReserved: 2,
      totalSold: 5,
      totalDefective: 1,
      productStockSummaries: [],
    }),
  };

  const controller = new AdminInventoryController(mockService as any);
  const result = await controller.getGlobalSummary();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.totalAvailable, 10);
  assert.strictEqual(result.summary.totalSold, 5);
});

test('AdminInventoryController.listProductInventory returns paginated items', async () => {
  const mockItems = [
    {
      id: 'inv-1',
      productId: 'prod-1',
      status: InventoryStatus.AVAILABLE,
      orderId: null,
      addedAt: '2024-01-01T00:00:00Z',
      soldAt: null,
      maskedCredential: 'u***r@example.com',
    },
  ];

  const mockService = {
    listProductInventory: async (productId: string, query: any) => ({
      items: mockItems,
      total: 1,
    }),
  };

  const controller = new AdminInventoryController(mockService as any);
  const result = await controller.listProductInventory('prod-1', '10', '0', 'AVAILABLE');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.total, 1);
});

test('AdminInventoryController.batchImportCredentials imports credentials', async () => {
  const mockService = {
    batchImportCredentials: async (productId: string, lines: string[]) => ({
      count: lines.length,
      addedAt: new Date().toISOString(),
    }),
  };

  const controller = new AdminInventoryController(mockService as any);
  const result = await controller.batchImportCredentials('prod-1', {
    credentials: ['key1', 'key2', 'key3'],
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.productId, 'prod-1');
});

test('AdminInventoryController.deleteCredential deletes available credential', async () => {
  const mockService = {
    deleteCredential: async (id: string) => true,
  };

  const controller = new AdminInventoryController(mockService as any);
  const result = await controller.deleteCredential('inv-1');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.deleted, true);
});

test('AdminInventoryController.updateCredentialStatus updates status', async () => {
  const mockService = {
    updateCredentialStatus: async (id: string, status: string) => true,
  };

  const controller = new AdminInventoryController(mockService as any);
  const result = await controller.updateCredentialStatus('inv-1', { status: 'DEFECTIVE' });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.updated, true);
});

test('AdminInventoryController.decryptCredential returns plaintext with audit', async () => {
  const mockService = {
    decryptSingleCredential: async (id: string, adminId: string, ip: string) => 'plaintext-credential',
  };

  const mockReq = {
    user: { id: 0 },
    ip: '127.0.0.1',
  };

  const controller = new AdminInventoryController(mockService as any);
  const result = await controller.decryptCredential('inv-1', mockReq);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.credential, 'plaintext-credential');
});
