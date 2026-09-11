import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert';
import { InventoryController } from './inventory.controller';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';

test('InventoryController has TelegramAuthGuard applied at class level', () => {
  const guards = Reflect.getMetadata('__guards__', InventoryController);
  assert.ok(Array.isArray(guards), 'Guards metadata must be an array');
  assert.ok(guards.includes(TelegramAuthGuard), 'TelegramAuthGuard must be attached to InventoryController');
});

test('InventoryController.getStockSummary returns { ok: true, summary }', async () => {
  const mockSummary = {
    available: 5,
    reserved: 2,
    sold: 10,
    defective: 0,
    total: 17,
  };
  const mockService = {
    getStockSummary: async (productId: string) => {
      assert.strictEqual(productId, 'prod-123');
      return mockSummary;
    },
  } as any;

  const controller = new InventoryController(mockService);
  const result = await controller.getStockSummary('prod-123');

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.summary, mockSummary);
});

test('InventoryController.addBatchCredentials delegates to service and returns count', async () => {
  const credentials = ['KEY-1', 'KEY-2', 'KEY-3'];
  const mockService = {
    addCredentials: async (productId: string, creds: string[]) => {
      assert.strictEqual(productId, 'prod-123');
      assert.deepStrictEqual(creds, credentials);
      return 3;
    },
  } as any;

  const controller = new InventoryController(mockService);
  const result = await controller.addBatchCredentials('prod-123', { credentials });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.productId, 'prod-123');
});

test('InventoryController.addBatchCredentials rejects non-array credentials', async () => {
  const mockService = {} as any;
  const controller = new InventoryController(mockService);

  await assert.rejects(
    () => controller.addBatchCredentials('prod-123', { credentials: null as any }),
    (err: any) => err?.getResponse()?.errorCode === 'INVALID_CREDENTIALS_PAYLOAD',
  );

  await assert.rejects(
    () => controller.addBatchCredentials('prod-123', {} as any),
    (err: any) => err?.getResponse()?.errorCode === 'INVALID_CREDENTIALS_PAYLOAD',
  );
});

test('InventoryController.addBatchCredentials rejects batch exceeding 500 items', async () => {
  const mockService = {} as any;
  const controller = new InventoryController(mockService);
  const tooMany = Array.from({ length: 501 }, (_, i) => `KEY-${i}`);

  await assert.rejects(
    () => controller.addBatchCredentials('prod-123', { credentials: tooMany }),
    (err: any) => err?.getResponse()?.errorCode === 'BATCH_SIZE_EXCEEDED',
  );
});
