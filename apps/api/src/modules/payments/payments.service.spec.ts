import { test } from 'node:test';
import assert from 'node:assert';
import { PaymentsService } from './payments.service';
import { VietQRService } from './vietqr.service';
import { PaymentStatus } from '@repo/shared-types';

const mockDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [],
      }),
    }),
  }),
  insert: () => ({
    values: () => ({
      returning: async () => [{
        id: 'payment-uuid-1',
        walletId: 'wallet-uuid-1',
        gateway: 'VIETQR',
        externalTransactionId: null,
        amount: '200000.00',
        status: 'PENDING',
        transferContent: '9R_TOPUP_7F3A',
        bankName: 'Vietcombank',
        bankBin: '970436',
        bankAccount: '1234567890',
        qrPayload: 'qr-payload',
        expiresAt: new Date('2026-09-10T21:30:00Z'),
        metadata: null,
        createdAt: new Date('2026-09-10T21:00:00Z'),
        updatedAt: new Date('2026-09-10T21:00:00Z'),
      }],
    }),
  }),
  transaction: async (fn: any) => fn(mockDb),
} as any;

const mockVietQR = {
  isConfigured: () => true,
  generateTransferContent: () => '9R_TOPUP_7F3A',
  generateVietQRPayload: () => 'qr-payload',
  generateVietQRUrl: () => 'https://img.vietqr.io/image/970436-1234567890-compact2.jpg?amount=200000&addInfo=9R_TOPUP_7F3A',
} as any;

const mockUserWallet = {
  upsertUserAndWallet: async () => ({
    user: { id: 'user-uuid-1' },
    wallet: { id: 'wallet-uuid-1' },
  }),
} as any;

const telegramUser = { id: 123456, first_name: 'Alice', username: 'alice_test', language_code: 'vi', is_premium: false };

test('PaymentsService.createVietQrPayment creates payment transaction', async () => {
  const service = new PaymentsService(mockVietQR, mockUserWallet);
  const result = await service.createVietQrPayment(telegramUser, 200000, mockDb);

  assert.strictEqual(result.transferContent, '9R_TOPUP_7F3A');
  assert.strictEqual(result.status, PaymentStatus.PENDING);
  assert.strictEqual(result.gateway, 'VIETQR');
  assert.strictEqual(result.amount, '200000.00');
  assert.ok(result.qrImageUrl?.includes('addInfo=9R_TOPUP_7F3A'));
});

test('PaymentsService.createVietQrPayment throws when amount below minimum', async () => {
  const service = new PaymentsService(mockVietQR, mockUserWallet);
  await assert.rejects(
    () => service.createVietQrPayment(telegramUser, 5000, mockDb),
    (err: any) => err?.status === 400 && err?.response?.errorCode === 'INVALID_TOPUP_AMOUNT',
  );
});

test('PaymentsService.createVietQrPayment throws when VietQR not configured', async () => {
  const unconfiguredVietQR = { ...mockVietQR, isConfigured: () => false } as any;
  const service = new PaymentsService(unconfiguredVietQR, mockUserWallet);
  await assert.rejects(
    () => service.createVietQrPayment(telegramUser, 200000, mockDb),
    (err: any) => err?.status === 503 && err?.response?.errorCode === 'VIETQR_NOT_CONFIGURED',
  );
});

test('PaymentsService.createVietQrPayment throws when transfer content conflicts after max retries', async () => {
  let selectCallCount = 0;
  const dbWithAlwaysExisting = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCallCount++;
            // First call is the existing-payment lookup; subsequent calls are transfer-content uniqueness checks.
            return selectCallCount > 1 ? [{ id: 'colliding' }] : [];
          },
        }),
      }),
    }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet);
  await assert.rejects(
    () => service.createVietQrPayment(telegramUser, 200000, dbWithAlwaysExisting),
    (err: any) => err?.status === 500 && err?.response?.errorCode === 'PAYMENT_TRANSFER_CONTENT_CONFLICT',
  );
});

test('PaymentsService.createVietQrPayment returns existing pending payment for same wallet+amount', async () => {
  const existingRecord = {
    id: 'payment-uuid-existing',
    walletId: 'wallet-uuid-1',
    gateway: 'VIETQR',
    externalTransactionId: null,
    amount: '200000.00',
    status: 'PENDING',
    transferContent: '9R_TOPUP_EXIST',
    bankName: 'Vietcombank',
    bankBin: '970436',
    bankAccount: '1234567890',
    qrPayload: 'qr-payload-old',
    expiresAt: new Date(Date.now() + 600000),
    metadata: null,
    createdAt: new Date('2026-09-10T21:00:00Z'),
    updatedAt: new Date('2026-09-10T21:00:00Z'),
  };

  const dbWithExisting = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [existingRecord],
        }),
      }),
    }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet);
  const result = await service.createVietQrPayment(telegramUser, 200000, dbWithExisting);

  assert.strictEqual(result.transferContent, '9R_TOPUP_EXIST');
  assert.strictEqual(result.id, 'payment-uuid-existing');
});
