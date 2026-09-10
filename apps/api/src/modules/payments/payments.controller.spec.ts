import { test } from 'node:test';
import assert from 'node:assert';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentStatus } from '@repo/shared-types';

const telegramUser = {
  id: 123456,
  first_name: 'Alice',
  username: 'alice_test',
  language_code: 'vi',
  is_premium: false,
};

const mockPayment = {
  id: 'payment-uuid-1',
  walletId: 'wallet-uuid-1',
  gateway: 'VIETQR',
  externalTransactionId: null,
  amount: '200000.00',
  status: PaymentStatus.PENDING,
  transferContent: '9R_TOPUP_7F3A',
  bankName: 'Vietcombank',
  bankBin: '970436',
  bankAccount: '1234567890',
  qrPayload: 'qr-payload',
  qrImageUrl: 'https://img.vietqr.io/image/970436-1234567890-compact2.jpg?amount=200000&addInfo=9R_TOPUP_7F3A',
  expiresAt: new Date('2026-09-10T21:30:00Z').toISOString(),
  metadata: null,
  createdAt: new Date('2026-09-10T21:00:00Z').toISOString(),
  updatedAt: new Date('2026-09-10T21:00:00Z').toISOString(),
};

const mockService = {
  createVietQrPayment: async (_dto: any, amount: number) => {
    if (amount !== 200000) throw new Error('Unexpected amount');
    return mockPayment;
  },
} as any;

test('PaymentsController.createVietQrPayment returns payment', async () => {
  const controller = new PaymentsController(mockService);
  const result = await controller.createVietQrPayment(telegramUser as any, { amount: 200000 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.payment.transferContent, '9R_TOPUP_7F3A');
  assert.strictEqual(result.payment.status, PaymentStatus.PENDING);
  assert.ok(result.payment.qrImageUrl?.includes('img.vietqr.io'));
});

test('PaymentsController.createVietQrPayment delegates amount to service', async () => {
  let capturedAmount: number | null = null;
  const service = {
    createVietQrPayment: async (_dto: any, amount: number) => {
      capturedAmount = amount;
      return mockPayment;
    },
  } as any;

  const controller = new PaymentsController(service);
  await controller.createVietQrPayment(telegramUser as any, { amount: 500000 });

  assert.strictEqual(capturedAmount, 500000);
});
