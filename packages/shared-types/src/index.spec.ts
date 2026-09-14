import { test } from 'node:test';
import assert from 'node:assert';
import {
  UserRole,
  OrderStatus,
  ProductSourcingMode,
  AdminAlertType,
  TelegramUserDto,
  TelegramInitDataResult,
  CATALOG_SYNC_QUEUE_NAME,
  type CatalogSyncJobData,
  type SyncStatusDto,
  type SyncTriggerResponseDto,
  type TestConnectionResponseDto,
} from './index';

test('Shared types exports valid enums matching Architecture Spine', () => {
  assert.strictEqual(UserRole.CUSTOMER, 'CUSTOMER');
  assert.strictEqual(OrderStatus.PENDING, 'PENDING');
  assert.strictEqual(OrderStatus.SOURCING, 'SOURCING');
  assert.strictEqual(OrderStatus.FULFILLED, 'FULFILLED');
  assert.strictEqual(ProductSourcingMode.IN_HOUSE, 'IN_HOUSE');
  assert.strictEqual(AdminAlertType.CATALOG_SYNC_FAILED, 'CATALOG_SYNC_FAILED');
});

test('Shared types exports catalog sync queue constants and DTO shapes', () => {
  assert.strictEqual(CATALOG_SYNC_QUEUE_NAME, 'catalog-sync-queue');

  const mockJobData: CatalogSyncJobData = { supplierId: 'sup-123' };
  assert.strictEqual(mockJobData.supplierId, 'sup-123');

  const mockStatus: SyncStatusDto = {
    isSyncing: true,
    lastSyncAt: '2026-09-14T00:00:00.000Z',
    lastSyncError: null,
    consecutiveSyncFailures: 0,
    syncIntervalSec: 3600,
  };
  assert.strictEqual(mockStatus.isSyncing, true);

  const mockTrigger: SyncTriggerResponseDto = {
    ok: true,
    jobId: 'sync:sup-123',
  };
  assert.strictEqual(mockTrigger.ok, true);
  assert.strictEqual(mockTrigger.jobId, 'sync:sup-123');

  const mockTestConn: TestConnectionResponseDto = {
    ok: true,
    status: 'healthy',
  };
  assert.strictEqual(mockTestConn.ok, true);
  assert.strictEqual(mockTestConn.status, 'healthy');
});

test('Shared types exports Telegram auth interfaces', () => {
  const mockUser: TelegramUserDto = {
    id: 123456789,
    firstName: 'Alice',
    username: 'alice_tg',
    isPremium: true,
    languageCode: 'vi',
  };
  const mockResult: TelegramInitDataResult = {
    ok: true,
    user: mockUser,
    authDate: 1700000000,
  };
  assert.strictEqual(mockResult.ok, true);
  assert.strictEqual(mockResult.user?.id, 123456789);
  assert.strictEqual(mockResult.user?.languageCode, 'vi');
});
