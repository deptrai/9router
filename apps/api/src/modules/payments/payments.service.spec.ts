import { test } from 'node:test';
import assert from 'node:assert';
import { PaymentsService } from './payments.service';
import { VietQRService } from './vietqr.service';
import { PaymentStatus } from '@repo/shared-types';

const mockDb = {
  select: () => ({
      from: (table: any) => ({
        where: (condition: any) => ({
          limit: async (n: number) => [],
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

const mockWallets = {
  credit: async () => ({ balanceAfter: '200000.00' }),
} as any;

const mockLedger = {} as any;

const telegramUser = { id: 123456, first_name: 'Alice', username: 'alice_test', language_code: 'vi', is_premium: false };

test('PaymentsService.createVietQrPayment creates payment transaction', async () => {
  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.createVietQrPayment(telegramUser, 200000, mockDb);

  assert.strictEqual(result.transferContent, '9R_TOPUP_7F3A');
  assert.strictEqual(result.status, PaymentStatus.PENDING);
  assert.strictEqual(result.gateway, 'VIETQR');
  assert.strictEqual(result.amount, '200000.00');
  assert.ok(result.qrImageUrl?.includes('addInfo=9R_TOPUP_7F3A'));
});

test('PaymentsService.createVietQrPayment throws when amount below minimum', async () => {
  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  await assert.rejects(
    () => service.createVietQrPayment(telegramUser, 5000, mockDb),
    (err: any) => err?.status === 400 && err?.response?.errorCode === 'INVALID_TOPUP_AMOUNT',
  );
});

test('PaymentsService.createVietQrPayment throws when VietQR not configured', async () => {
  const unconfiguredVietQR = { ...mockVietQR, isConfigured: () => false } as any;
  const service = new PaymentsService(unconfiguredVietQR, mockUserWallet, mockWallets, mockLedger);
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
      from: (table: any) => ({
        where: (condition: any) => ({
          limit: async (n: number) => {
            selectCallCount++;
            // First call is the existing-payment lookup; subsequent calls are transfer-content uniqueness checks.
            return selectCallCount > 1 ? [{ id: 'colliding' }] : [];
          },
        }),
      }),
    }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
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
      from: (table: any) => ({
        where: (condition: any) => ({
          limit: async (n: number) => [existingRecord],
        }),
      }),
    }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.createVietQrPayment(telegramUser, 200000, dbWithExisting);

  assert.strictEqual(result.transferContent, '9R_TOPUP_EXIST');
  assert.strictEqual(result.id, 'payment-uuid-existing');
});



const webhookDto = {
  transactionId: 'VQR-ABC123',
  amount: 200000,
  content: '9R_TOPUP_7F3A',
  bankCode: '970436',
  accountNo: '1234567890',
  timestamp: '2026-09-10T21:30:00Z',
};

function createMockTx(overrides: { selectResults?: any[]; updateRows?: any[] } = {}) {
  const { selectResults = [], updateRows = [] } = overrides;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectResults,
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [],
      }),
    }),
    update: () => ({
      set: (s: any) => ({
        where: () => Promise.resolve(updateRows),
      }),
    }),
  } as any;
}

test('PaymentsService.processVietQRWebhook credits wallet and completes payment', async () => {
  let updateSet: any = null;
  let selectCallCount = 0;

  const mockTx = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCallCount++;
            if (selectCallCount === 1) return []; // alreadyProcessed check
            return [{ id: 'payment-uuid-1', walletId: 'wallet-uuid-1', amount: '200000.00', status: 'PENDING', transferContent: '9R_TOPUP_7F3A', metadata: null }];
          },
        }),
      }),
    }),
    update: () => ({
      set: (s: any) => {
        updateSet = s;
        return { where: () => ({ returning: async () => [{}] }) };
      },
    }),
  } as any;

  const wallets = {
    credit: async (walletId: string, amount: string, type: string, idempotencyKey: string, referenceId: string) => {
      assert.strictEqual(walletId, 'wallet-uuid-1');
      assert.strictEqual(amount, '200000.00');
      assert.strictEqual(type, 'TOPUP_VIETQR');
      assert.strictEqual(idempotencyKey, 'payment:vietqr:VQR-ABC123');
      assert.strictEqual(referenceId, 'payment-uuid-1');
      return { balanceAfter: '200000.00' };
    },
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, wallets, mockLedger);
  const result = await service.processVietQRWebhook(webhookDto, mockTx);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.credited, true);
  assert.strictEqual(result.paymentId, 'payment-uuid-1');
  assert.strictEqual(result.walletId, 'wallet-uuid-1');
  assert.strictEqual(result.balanceAfter, '200000.00');
  assert.strictEqual(updateSet.status, 'COMPLETED');
  assert.strictEqual(updateSet.externalTransactionId, 'VQR-ABC123');
});

test('PaymentsService.processVietQRWebhook returns alreadyProcessed for duplicate transactionId', async () => {
  const mockTx = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{
            id: 'payment-uuid-2',
            walletId: 'wallet-uuid-1',
            amount: '200000.00',
            status: 'COMPLETED',
            transferContent: '9R_TOPUP_7F3A',
            externalTransactionId: 'VQR-ABC123',
          }],
        }),
      }),
    }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook(webhookDto, mockTx);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.alreadyProcessed, true);
});

test('PaymentsService.processVietQRWebhook returns NO_MATCHING_PAYMENT when not found', async () => {
  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook(webhookDto, mockDb);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.matched, false);
  assert.strictEqual(result.reason, 'NO_MATCHING_PAYMENT');
});

test('PaymentsService.processVietQRWebhook returns AMOUNT_MISMATCH when amount differs', async () => {
  let selectCallCount = 0;
  const mockTx = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCallCount++;
            if (selectCallCount === 1) return [];
            return [{ id: 'payment-uuid-1', walletId: 'wallet-uuid-1', amount: '150000.00', status: 'PENDING', transferContent: '9R_TOPUP_7F3A', metadata: null }];
          },
        }),
      }),
    }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook(webhookDto, mockTx);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.credited, false);
  assert.strictEqual(result.reason, 'AMOUNT_MISMATCH');
});

test('PaymentsService.processVietQRWebhook returns ALREADY_PROCESSED for non-PENDING payment', async () => {
  let selectCallCount = 0;
  const mockTx = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCallCount++;
            if (selectCallCount === 1) return [];
            return [{ id: 'payment-uuid-1', walletId: 'wallet-uuid-1', amount: '200000.00', status: 'EXPIRED', transferContent: '9R_TOPUP_7F3A', metadata: null }];
          },
        }),
      }),
    }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook(webhookDto, mockTx);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.credited, false);
  assert.strictEqual(result.reason, 'ALREADY_PROCESSED');
  assert.strictEqual(result.currentStatus, 'EXPIRED');
});

test('PaymentsService.processVietQRWebhook throws AMBIGUOUS_MATCH for multiple pending payments', async () => {
  let selectCallCount = 0;
  const mockTx = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCallCount++;
            if (selectCallCount === 1) return [];
            return [
              { id: 'payment-uuid-1', walletId: 'wallet-uuid-1', amount: '200000.00', status: 'PENDING', transferContent: '9R_TOPUP_7F3A', metadata: null },
              { id: 'payment-uuid-2', walletId: 'wallet-uuid-2', amount: '200000.00', status: 'PENDING', transferContent: '9R_TOPUP_7F3A', metadata: null },
            ];
          },
        }),
      }),
    }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  await assert.rejects(
    () => service.processVietQRWebhook(webhookDto, mockTx),
    (err: any) => err?.status === 500 && err?.response?.errorCode === 'PAYMENT_AMBIGUOUS_MATCH',
  );
});

test('PaymentsService.processVietQRWebhook rejects missing transactionId', async () => {
  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook({ amount: 200000, content: '9R_TOPUP_7F3A' } as any, mockDb);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'WEBHOOK_INVALID_PAYLOAD');
});

test('PaymentsService.processVietQRWebhook rejects invalid amount', async () => {
  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook({ ...webhookDto, amount: 5000 }, mockDb);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'WEBHOOK_INVALID_AMOUNT');
});

test('PaymentsService.processVietQRWebhook returns PAYMENT_EXPIRED when payment is past expiry', async () => {
  let selectCallCount = 0;
  const mockTx = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCallCount++;
            if (selectCallCount === 1) return [];
            return [{
              id: 'payment-uuid-1',
              walletId: 'wallet-uuid-1',
              amount: '200000.00',
              status: 'PENDING',
              transferContent: '9R_TOPUP_7F3A',
              metadata: null,
              expiresAt: new Date(Date.now() - 60_000),
            }];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{}] }) }),
    }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook(webhookDto, mockTx);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.credited, false);
  assert.strictEqual(result.reason, 'PAYMENT_EXPIRED');
});

test('PaymentsService.processVietQRWebhook returns alreadyProcessed when update finds no PENDING row', async () => {
  let selectCallCount = 0;
  const mockTx = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCallCount++;
            if (selectCallCount === 1) return [];
            return [{ id: 'payment-uuid-1', walletId: 'wallet-uuid-1', amount: '200000.00', status: 'PENDING', transferContent: '9R_TOPUP_7F3A', metadata: null }];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook(webhookDto, mockTx);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.alreadyProcessed, true);
});

test('PaymentsService.processVietQRWebhook returns alreadyProcessed on 23505 error', async () => {
  let selectCallCount = 0;
  const mockTx = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCallCount++;
            if (selectCallCount === 1) return [];
            return [{ id: 'payment-uuid-1', walletId: 'wallet-uuid-1', amount: '200000.00', status: 'PENDING', transferContent: '9R_TOPUP_7F3A', metadata: null }];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => { const e: any = new Error('duplicate key'); e.code = '23505'; throw e; } }) }),
    }),
  } as any;

  const wallets = {
    credit: async () => ({ balanceAfter: '200000.00' }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, wallets, mockLedger);
  const result = await service.processVietQRWebhook(webhookDto, mockTx);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.alreadyProcessed, true);
});

test('PaymentsService.processVietQRWebhook throws WEBHOOK_PROCESSING_FAILED on unexpected error', async () => {
  let selectCallCount = 0;
  const mockTx = {
    ...mockDb,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCallCount++;
            if (selectCallCount === 1) return [];
            return [{ id: 'payment-uuid-1', walletId: 'wallet-uuid-1', amount: '200000.00', status: 'PENDING', transferContent: '9R_TOPUP_7F3A', metadata: null }];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => { throw new Error('db offline'); } }) }),
    }),
  } as any;

  const wallets = {
    credit: async () => ({ balanceAfter: '200000.00' }),
  } as any;

  const service = new PaymentsService(mockVietQR, mockUserWallet, wallets, mockLedger);
  await assert.rejects(
    () => service.processVietQRWebhook(webhookDto, mockTx),
    (err: any) => err?.status === 500 && err?.response?.errorCode === 'WEBHOOK_PROCESSING_FAILED',
  );
});

test('PaymentsService.processVietQRWebhook rejects non-string transactionId', async () => {
  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook({ ...webhookDto, transactionId: 12345 } as any, mockDb);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'WEBHOOK_INVALID_PAYLOAD');
});

test('PaymentsService.processVietQRWebhook rejects non-string content', async () => {
  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook({ ...webhookDto, content: 12345 } as any, mockDb);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'WEBHOOK_INVALID_PAYLOAD');
});

test('PaymentsService.processVietQRWebhook rejects malformed timestamp', async () => {
  const service = new PaymentsService(mockVietQR, mockUserWallet, mockWallets, mockLedger);
  const result = await service.processVietQRWebhook({ ...webhookDto, timestamp: 'not-a-date' } as any, mockDb);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'WEBHOOK_INVALID_PAYLOAD');
});
