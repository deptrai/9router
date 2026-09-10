import { test } from 'node:test';
import assert from 'node:assert';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

const mockService = {
  createVietQrPayment: async (_user: any, amount: number) => ({
    id: 'payment-uuid-1',
    amount: amount.toFixed(2),
    status: 'PENDING',
    transferContent: '9R_TOPUP_7F3A',
  }),
  processVietQRWebhook: async (dto: any) => ({
    ok: true,
    matched: true,
    credited: true,
    paymentId: 'payment-uuid-1',
    walletId: 'wallet-uuid-1',
    balanceAfter: '200000.00',
  }),
  createBitcartPayment: async (_user: any, amount: number, coin: string, network: string) => ({
    id: 'payment-uuid-2',
    amount: amount.toFixed(2),
    status: 'PENDING',
    transferContent: '9R_CRYPTO_AB12',
    gateway: 'BITCART',
    externalTransactionId: 'bitcart-invoice-1',
    metadata: { coin, network },
  }),
  processBitcartWebhook: async (dto: any) => ({
    ok: true,
    matched: true,
    credited: true,
    paymentId: 'payment-uuid-2',
    walletId: 'wallet-uuid-1',
    balanceAfter: '200000.00',
  }),
} as any;

const telegramUser = {
  id: 123456,
  first_name: 'Alice',
  username: 'alice_test',
  language_code: 'vi',
  is_premium: false,
};

test('PaymentsController.createVietQrPayment returns payment', async () => {
  const controller = new PaymentsController(mockService);
  const result = await controller.createVietQrPayment(telegramUser as any, { amount: 200000 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.payment.amount, '200000.00');
});

test('PaymentsController.createVietQrPayment validates body.amount is integer >= 10000', async () => {
  const controller = new PaymentsController(mockService);
  await assert.rejects(
    () => controller.createVietQrPayment(telegramUser as any, { amount: 5000 } as any),
    (err: any) => err?.status === 400 && err?.response?.errorCode === 'INVALID_TOPUP_AMOUNT',
  );
});

test('PaymentsController.createVietQrPayment rejects missing amount', async () => {
  const controller = new PaymentsController(mockService);
  await assert.rejects(
    () => controller.createVietQrPayment(telegramUser as any, {} as any),
    (err: any) => err?.status === 400,
  );
});

test('PaymentsController.createVietQrPayment delegates amount to service', async () => {
  let capturedAmount: number | null = null;
  const service = {
    createVietQrPayment: async (_dto: any, amount: number) => {
      capturedAmount = amount;
      return { id: 'payment-uuid-1', amount: '500000.00', status: 'PENDING' };
    },
  } as any;

  const controller = new PaymentsController(service);
  await controller.createVietQrPayment(telegramUser as any, { amount: 500000 });

  assert.strictEqual(capturedAmount, 500000);
});

test('PaymentsController.processVietQRWebhook delegates to service and returns result', async () => {
  const controller = new PaymentsController(mockService);
  const result = await controller.processVietQRWebhook({
    transactionId: 'VQR-ABC123',
    amount: 200000,
    content: '9R_TOPUP_7F3A',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.credited, true);
  assert.strictEqual(result.balanceAfter, '200000.00');
});

test('PaymentsController.createBitcartPayment returns payment', async () => {
  const controller = new PaymentsController(mockService);
  const result = await controller.createBitcartPayment(telegramUser as any, {
    amount: 200000,
    coin: 'USDT',
    network: 'TRON',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.payment.gateway, 'BITCART');
  assert.strictEqual(result.payment.amount, '200000.00');
});

test('PaymentsController.createBitcartPayment validates amount is integer >= 10000', async () => {
  const controller = new PaymentsController(mockService);
  await assert.rejects(
    () => controller.createBitcartPayment(telegramUser as any, { amount: 5000, coin: 'USDT', network: 'TRON' } as any),
    (err: any) => err?.status === 400,
  );
});

test('PaymentsController.createBitcartPayment rejects missing coin/network', async () => {
  const controller = new PaymentsController(mockService);
  await assert.rejects(
    () => controller.createBitcartPayment(telegramUser as any, { amount: 200000 } as any),
    (err: any) => err?.status === 400,
  );
});

test('PaymentsController.processBitcartWebhook delegates to service and returns result', async () => {
  const controller = new PaymentsController(mockService);
  const result = await controller.processBitcartWebhook({
    id: 'bitcart-invoice-1',
    status: 'complete',
    payments: [{ amount: 8.0 }],
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.credited, true);
  assert.strictEqual(result.balanceAfter, '200000.00');
});
