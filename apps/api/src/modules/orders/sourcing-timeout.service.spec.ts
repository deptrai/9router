import { test } from 'node:test';
import assert from 'node:assert';
import { OrderStatus, LedgerType, SupplierOrderStatus } from '@repo/shared-types';

/**
 * Red-phase ATDD Scaffolds for Story 4.4:
 * Sourcing Timeout & Sweeper Service (AC #1, AC #2, AC #3)
 * Target implementation: apps/api/src/modules/orders/sourcing-timeout.service.ts
 *
 * All tests use test() for RED phase compliance.
 */

// Helper mock types for testing SourcingTimeoutService
interface MockLedgerService {
  credit: (...args: any[]) => Promise<any>;
}

interface MockTelegramBotService {
  sendRefundNotice: (...args: any[]) => Promise<any>;
  sendAdminAlert: (...args: any[]) => Promise<any>;
}

test('[P0] SourcingTimeoutService.cancelAndRefund: atomically transitions SOURCING to REFUNDED with status guard', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Service not implemented yet
  const { SourcingTimeoutService } = await import('./sourcing-timeout.service' as string);
  
  let executedTx = false;
  let statusGuardApplied = false;
  let orderUpdatedToRefunded = false;

  const mockDb = {
    query: {
      orders: {
        findFirst: async () => ({
          id: 'order-123',
          userId: 'user-456',
          productId: 'prod-789',
          status: OrderStatus.SOURCING,
          price: '50000.00',
          createdAt: new Date(Date.now() - 65_000),
        }),
      },
      products: {
        findFirst: async () => ({ id: 'prod-789', title: 'Netflix 1 Month', supplierSourceId: 'sup-1' }),
      },
      users: {
        findFirst: async () => ({ id: 'user-456', telegramId: '999888' }),
      },
    },
    transaction: async (cb: any) => {
      executedTx = true;
      const tx = {
        update: () => ({
          set: (vals: any) => ({
            where: () => ({
              returning: async () => {
                statusGuardApplied = true;
                if (vals.status === OrderStatus.REFUNDED) {
                  orderUpdatedToRefunded = true;
                  return [{ id: 'order-123', status: OrderStatus.REFUNDED, price: '50000.00', userId: 'user-456' }];
                }
                return [];
              },
            }),
          }),
        }),
        execute: async () => [{ id: 'wallet-789', userId: 'user-456', balance: '10000.00' }],
        insert: () => ({
          values: async () => ({}),
        }),
      };
      return cb(tx);
    },
  };

  const mockLedgerService: MockLedgerService = {
    credit: async () => ({ id: 'ledger-tx-1' }),
  };
  const mockTelegramBotService: MockTelegramBotService = {
    sendRefundNotice: async () => {},
    sendAdminAlert: async () => {},
  };

  const service = new SourcingTimeoutService(mockDb as any, mockLedgerService as any, mockTelegramBotService as any);
  const result = await service.cancelAndRefund('order-123', 'SOURCING_TIMEOUT_60S', 'DELAYED_TIMEOUT');

  assert.strictEqual(executedTx, true, 'Cancellation and refund must run inside a DB transaction');
  assert.strictEqual(statusGuardApplied, true, 'Status guard WHERE clause must be applied');
  assert.strictEqual(orderUpdatedToRefunded, true, 'Order status must be updated to REFUNDED');
  assert.strictEqual(result.refunded, true, 'Should return refunded: true');
  assert.strictEqual(result.order?.status, OrderStatus.REFUNDED);
});

test('[P0] SourcingTimeoutService.cancelAndRefund: credits 100% order price to wallet with PURCHASE_REFUND and idempotency key', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Service not implemented yet
  const { SourcingTimeoutService } = await import('./sourcing-timeout.service' as string);

  let creditArgs: any = null;
  const mockLedgerService: MockLedgerService = {
    credit: async (walletId, amount, type, idempotencyKey, referenceId, tx) => {
      creditArgs = { walletId, amount, type, idempotencyKey, referenceId, hasTx: Boolean(tx) };
      return { id: 'ledger-tx-1' };
    },
  };

  const mockDb = {
    query: {
      orders: {
        findFirst: async () => ({
          id: 'order-refund-100',
          userId: 'user-1',
          productId: 'prod-1',
          status: OrderStatus.SOURCING,
          price: '125000.00',
        }),
      },
      products: { findFirst: async () => ({ id: 'prod-1', title: 'Spotify Premium' }) },
      users: { findFirst: async () => ({ id: 'user-1', telegramId: '12345' }) },
    },
    transaction: async (cb: any) => {
      const tx = {
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => [{ id: 'order-refund-100', status: OrderStatus.REFUNDED, price: '125000.00', userId: 'user-1' }],
            }),
          }),
        }),
        execute: async () => [{ id: 'wallet-user-1', userId: 'user-1', balance: '0.00' }],
        insert: () => ({ values: async () => ({}) }),
      };
      return cb(tx);
    },
  };

  const service = new SourcingTimeoutService(mockDb as any, mockLedgerService as any, { sendRefundNotice: async () => {}, sendAdminAlert: async () => {} } as any);
  await service.cancelAndRefund('order-refund-100', 'SOURCING_TIMEOUT_60S', 'DELAYED_TIMEOUT');

  assert.ok(creditArgs, 'ledgerService.credit must be called');
  assert.strictEqual(creditArgs.walletId, 'wallet-user-1');
  assert.strictEqual(creditArgs.amount, '125000.00', 'Must refund 100% of order value');
  assert.strictEqual(creditArgs.type, LedgerType.PURCHASE_REFUND);
  assert.strictEqual(creditArgs.idempotencyKey, 'sourcing-refund:order-refund-100');
  assert.strictEqual(creditArgs.referenceId, 'order-refund-100');
  assert.strictEqual(creditArgs.hasTx, true, 'Credit must execute within transaction context');
});

test('[P0] SourcingTimeoutService.cancelAndRefund: creates FAILED audit log in supplier_orders table', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Service not implemented yet
  const { SourcingTimeoutService } = await import('./sourcing-timeout.service' as string);

  let insertedSupplierOrder: any = null;
  const mockDb = {
    query: {
      orders: {
        findFirst: async () => ({
          id: 'order-audit-trail',
          userId: 'user-1',
          productId: 'prod-1',
          status: OrderStatus.SOURCING,
          price: '50000.00',
        }),
      },
      products: { findFirst: async () => ({ id: 'prod-1', title: 'VPN 1 Month', supplierSourceId: 'sup-source-9' }) },
      users: { findFirst: async () => ({ id: 'user-1', telegramId: '123' }) },
    },
    transaction: async (cb: any) => {
      const tx = {
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => [{ id: 'order-audit-trail', status: OrderStatus.REFUNDED, price: '50000.00', userId: 'user-1' }],
            }),
          }),
        }),
        execute: async () => [{ id: 'wallet-1', userId: 'user-1' }],
        insert: () => ({
          values: async (vals: any) => {
            insertedSupplierOrder = vals;
          },
        }),
      };
      return cb(tx);
    },
  };

  const service = new SourcingTimeoutService(mockDb as any, { credit: async () => ({}) } as any, { sendRefundNotice: async () => {}, sendAdminAlert: async () => {} } as any);
  await service.cancelAndRefund('order-audit-trail', 'SOURCING_TIMEOUT_60S', 'DELAYED_TIMEOUT');

  assert.ok(insertedSupplierOrder, 'supplier_orders record must be inserted');
  assert.strictEqual(insertedSupplierOrder.orderId, 'order-audit-trail');
  assert.strictEqual(insertedSupplierOrder.status, SupplierOrderStatus.FAILED);
  assert.strictEqual(insertedSupplierOrder.errorMessage, 'SOURCING_TIMEOUT_60S:DELAYED_TIMEOUT');
  assert.strictEqual(insertedSupplierOrder.supplierSourceId, 'sup-source-9');
});

test('[P0] SourcingTimeoutService.cancelAndRefund: returns { refunded: false } safely without ledger credit when order is already FULFILLED (concurrency guard)', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Service not implemented yet
  const { SourcingTimeoutService } = await import('./sourcing-timeout.service' as string);

  let ledgerCreditCalled = false;
  let telegramNoticeCalled = false;

  const mockDb = {
    query: {
      orders: {
        findFirst: async () => ({
          id: 'order-already-fulfilled',
          userId: 'user-1',
          productId: 'prod-1',
          status: OrderStatus.FULFILLED, // Already fulfilled by scraper
          price: '50000.00',
        }),
      },
      products: { findFirst: async () => ({ id: 'prod-1', title: 'Product' }) },
      users: { findFirst: async () => ({ id: 'user-1', telegramId: '123' }) },
    },
    transaction: async (cb: any) => {
      const tx = {
        update: () => ({
          set: () => ({
            where: () => ({
              // 0 rows returned because WHERE status = 'SOURCING' did not match
              returning: async () => [],
            }),
          }),
        }),
        execute: async () => [{ id: 'wallet-1', userId: 'user-1' }],
        insert: () => ({ values: async () => ({}) }),
      };
      return cb(tx);
    },
  };

  const mockLedger: MockLedgerService = {
    credit: async () => {
      ledgerCreditCalled = true;
      return {};
    },
  };
  const mockTelegram: MockTelegramBotService = {
    sendRefundNotice: async () => {
      telegramNoticeCalled = true;
    },
    sendAdminAlert: async () => {},
  };

  const service = new SourcingTimeoutService(mockDb as any, mockLedger as any, mockTelegram as any);
  const result = await service.cancelAndRefund('order-already-fulfilled', 'SOURCING_TIMEOUT_60S', 'DELAYED_TIMEOUT');

  assert.strictEqual(result.refunded, false, 'Should return refunded: false on race condition');
  assert.strictEqual(ledgerCreditCalled, false, 'Must not credit ledger if order was already fulfilled');
  assert.strictEqual(telegramNoticeCalled, false, 'Must not send buyer refund notice if order was already fulfilled');
});

test('[P1] SourcingTimeoutService.cancelAndRefund: dispatches Telegram refund notice to buyer post-commit', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Service not implemented yet
  const { SourcingTimeoutService } = await import('./sourcing-timeout.service' as string);

  let sentNotice = false;
  let noticeArgs: any = null;

  const mockDb = {
    query: {
      orders: {
        findFirst: async () => ({
          id: 'order-tg-notice',
          userId: 'user-tg',
          productId: 'prod-tg',
          status: OrderStatus.SOURCING,
          price: '80000.00',
        }),
      },
      products: { findFirst: async () => ({ id: 'prod-tg', title: 'Grammarly 1 Year' }) },
      users: { findFirst: async () => ({ id: 'user-tg', telegramId: '987654321' }) },
    },
    transaction: async (cb: any) => {
      const tx = {
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => [{ id: 'order-tg-notice', status: OrderStatus.REFUNDED, price: '80000.00', userId: 'user-tg' }],
            }),
          }),
        }),
        execute: async () => [{ id: 'wallet-tg', userId: 'user-tg' }],
        insert: () => ({ values: async () => ({}) }),
      };
      return cb(tx);
    },
  };

  const mockTelegram: MockTelegramBotService = {
    sendRefundNotice: async (telegramId, order, productTitle) => {
      sentNotice = true;
      noticeArgs = { telegramId, order, productTitle };
    },
    sendAdminAlert: async () => {},
  };

  const service = new SourcingTimeoutService(mockDb as any, { credit: async () => ({}) } as any, mockTelegram as any);
  await service.cancelAndRefund('order-tg-notice', 'SOURCING_TIMEOUT_60S', 'DELAYED_TIMEOUT');

  assert.strictEqual(sentNotice, true, 'Telegram refund notice must be dispatched');
  assert.strictEqual(noticeArgs.telegramId, '987654321');
  assert.strictEqual(noticeArgs.productTitle, 'Grammarly 1 Year');
});

test('[P1] SourcingTimeoutService.cancelAndRefund: tolerates Telegram bot failure without rolling back refund', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Service not implemented yet
  const { SourcingTimeoutService } = await import('./sourcing-timeout.service' as string);

  const mockDb = {
    query: {
      orders: {
        findFirst: async () => ({
          id: 'order-tg-fail',
          userId: 'user-1',
          productId: 'prod-1',
          status: OrderStatus.SOURCING,
          price: '50000.00',
        }),
      },
      products: { findFirst: async () => ({ id: 'prod-1', title: 'Netflix' }) },
      users: { findFirst: async () => ({ id: 'user-1', telegramId: '123' }) },
    },
    transaction: async (cb: any) => {
      const tx = {
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => [{ id: 'order-tg-fail', status: OrderStatus.REFUNDED, price: '50000.00', userId: 'user-1' }],
            }),
          }),
        }),
        execute: async () => [{ id: 'wallet-1', userId: 'user-1' }],
        insert: () => ({ values: async () => ({}) }),
      };
      return cb(tx);
    },
  };

  const mockTelegram: MockTelegramBotService = {
    sendRefundNotice: async () => {
      throw new Error('Telegram API network timeout');
    },
    sendAdminAlert: async () => {},
  };

  const service = new SourcingTimeoutService(mockDb as any, { credit: async () => ({}) } as any, mockTelegram as any);
  // Should NOT throw exception when Telegram fails
  const result = await service.cancelAndRefund('order-tg-fail', 'SOURCING_TIMEOUT_60S', 'DELAYED_TIMEOUT');
  assert.strictEqual(result.refunded, true, 'Refund must succeed even if Telegram notification fails');
});

test('[P1] SourcingTimeoutService.cancelAndRefund: sends admin alert when triggered by SWEEPER source', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Service not implemented yet
  const { SourcingTimeoutService } = await import('./sourcing-timeout.service' as string);

  let adminAlertCalled = false;
  const mockTelegram: MockTelegramBotService = {
    sendRefundNotice: async () => {},
    sendAdminAlert: async () => {
      adminAlertCalled = true;
    },
  };

  const mockDb = {
    query: {
      orders: {
        findFirst: async () => ({
          id: 'order-sweeper',
          userId: 'user-1',
          productId: 'prod-1',
          status: OrderStatus.SOURCING,
          price: '50000.00',
        }),
      },
      products: { findFirst: async () => ({ id: 'prod-1', title: 'Product' }) },
      users: { findFirst: async () => ({ id: 'user-1', telegramId: '123' }) },
    },
    transaction: async (cb: any) => {
      const tx = {
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => [{ id: 'order-sweeper', status: OrderStatus.REFUNDED, price: '50000.00', userId: 'user-1' }],
            }),
          }),
        }),
        execute: async () => [{ id: 'wallet-1', userId: 'user-1' }],
        insert: () => ({ values: async () => ({}) }),
      };
      return cb(tx);
    },
  };

  const service = new SourcingTimeoutService(mockDb as any, { credit: async () => ({}) } as any, mockTelegram as any);
  await service.cancelAndRefund('order-sweeper', 'SOURCING_SWEEPER_TIMEOUT_60S', 'SWEEPER');

  assert.strictEqual(adminAlertCalled, true, 'Admin alert must be sent when sweeper rescues expired order');
});

test('[P1] SourcingTimeoutService.sweepExpiredOrders: queries expired SOURCING orders and rescues them', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Service not implemented yet
  const { SourcingTimeoutService } = await import('./sourcing-timeout.service' as string);

  const expiredList = [
    { id: 'exp-order-1', status: OrderStatus.SOURCING, createdAt: new Date(Date.now() - 70_000) },
    { id: 'exp-order-2', status: OrderStatus.SOURCING, createdAt: new Date(Date.now() - 90_000) },
  ];

  const mockDb = {
    select: () => ({
      from: () => ({
        where: async () => expiredList,
      }),
    }),
  };

  const service = new SourcingTimeoutService(mockDb as any, { credit: async () => ({}) } as any, { sendRefundNotice: async () => {}, sendAdminAlert: async () => {} } as any);
  
  // Mock cancelAndRefund on instance to track sweeper calls
  let rescuedCount = 0;
  service.cancelAndRefund = async (orderId: string, reason: string, source: string) => {
    assert.strictEqual(source, 'SWEEPER');
    assert.strictEqual(reason, 'SOURCING_SWEEPER_TIMEOUT_60S');
    rescuedCount++;
    return { refunded: true };
  };

  const count = await service.sweepExpiredOrders(60);
  assert.strictEqual(count, 2, 'Should sweep and rescue both expired orders');
  assert.strictEqual(rescuedCount, 2);
});

test('[P2] SourcingTimeoutService.cancelAndRefund: throws NotFoundException when order does not exist', async () => {
  // THIS TEST WILL FAIL (RED PHASE) - Service not implemented yet
  const { SourcingTimeoutService } = await import('./sourcing-timeout.service' as string);

  const mockDb = {
    query: {
      orders: {
        findFirst: async () => null,
      },
    },
  };

  const service = new SourcingTimeoutService(mockDb as any, {} as any, {} as any);
  await assert.rejects(
    async () => {
      await service.cancelAndRefund('non-existent-order', 'TIMEOUT', 'DELAYED_TIMEOUT');
    },
    /not found/i,
  );
});
