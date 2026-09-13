import { test } from 'node:test';
import assert from 'node:assert';
import { OrderStatus, LedgerType } from '@repo/shared-types';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminOrdersService } from './admin-orders.service';

function makeService() {
  const ledgerCalls: any[] = [];
  const mockLedgerService: any = {
    credit: async (...args: any[]) => {
      ledgerCalls.push(args);
      return { id: 'tx-refund' };
    },
  };

  const telegramCalls: any[] = [];
  const mockTelegramBotService: any = {
    sendRefundNotice: async (...args: any[]) => {
      telegramCalls.push(args);
    },
  };

  const service = new AdminOrdersService(
    mockLedgerService,
    mockTelegramBotService,
  );

  return { service, ledgerCalls, telegramCalls };
}

test('[P0] AdminOrdersService: listAdminOrders returns paginated order rows with total count', async () => {
  const { service } = makeService();
  const chainBuilder: any = {
    innerJoin: () => chainBuilder,
    leftJoin: () => chainBuilder,
    where: () => chainBuilder,
    orderBy: () => chainBuilder,
    limit: () => chainBuilder,
    offset: () =>
      Promise.resolve([
        {
          order: {
            id: 'order-1',
            userId: 'user-1',
            productId: 'prod-1',
            price: '50000.00',
            status: OrderStatus.PAID,
            createdAt: new Date(),
            fulfilledAt: null,
          },
          user: {
            telegramId: 111222,
            username: 'test_user',
          },
          product: {
            title: 'Test Product',
            sourcingMode: 'IN_HOUSE',
          },
          supplier: null,
        },
      ]),
    then: (resolve: any) => resolve([{ count: 1 }]),
  };

  const mockTx: any = {
    select: () => ({
      from: () => chainBuilder,
    }),
  };

  const result = await service.listAdminOrders({ limit: 10, offset: 0 }, mockTx);
  assert.strictEqual(result.orders.length, 1);
  assert.strictEqual(result.orders[0].id, 'order-1');
  assert.strictEqual(result.orders[0].telegramId, 111222);
  assert.strictEqual(result.orders[0].productTitle, 'Test Product');
  assert.strictEqual(result.total, 1);
});

test('[P0] AdminOrdersService: getAdminOrderDetail returns complete order, customer, product, and traces', async () => {
  const { service } = makeService();
  const mockTx: any = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          leftJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      order: {
                        id: 'order-1',
                        userId: 'user-1',
                        productId: 'prod-1',
                        price: '50000.00',
                        status: OrderStatus.FULFILLED,
                        deliveredCredential: 'user:pass123',
                        createdAt: new Date(),
                        fulfilledAt: new Date(),
                      },
                      user: {
                        id: 'user-1',
                        telegramId: 12345,
                        username: 'alice',
                        firstName: 'Alice',
                        lastName: 'Smith',
                      },
                      wallet: {
                        balance: '100000.00',
                      },
                      product: {
                        id: 'prod-1',
                        title: 'Product One',
                        slug: 'prod-one',
                        price: '50000.00',
                        sourcingMode: 'IN_HOUSE',
                        category: 'accounts',
                      },
                    },
                  ]),
              }),
            }),
          }),
        }),
        leftJoin: () => ({
          where: () => ({
            orderBy: () =>
              Promise.resolve([
                {
                  trace: {
                    id: 'trace-1',
                    orderId: 'order-1',
                    status: 'SUCCESS',
                    cost: '40000.00',
                    errorMessage: null,
                    createdAt: new Date(),
                    completedAt: new Date(),
                  },
                  supplierName: 'Upstream Provider',
                },
              ]),
          }),
        }),
        where: () => ({
          orderBy: () =>
            Promise.resolve([
              {
                id: 'lt-1',
                walletId: 'w-1',
                type: LedgerType.STORE_PURCHASE,
                amount: '-50000.00',
                balanceBefore: '150000.00',
                balanceAfter: '100000.00',
                referenceId: 'order-1',
                createdAt: new Date(),
              },
            ]),
        }),
      }),
    }),
  };

  const detail = await service.getAdminOrderDetail('order-1', mockTx);
  assert.strictEqual(detail.order.id, 'order-1');
  assert.strictEqual(detail.customer.username, 'alice');
  assert.strictEqual(detail.product.title, 'Product One');
  assert.strictEqual(detail.supplierTraces.length, 1);
  assert.strictEqual(detail.ledgerTransactions.length, 1);
  // Credential should be masked
  assert.strictEqual(detail.order.deliveredCredential?.includes('pass123'), false);
});

test('[P0] AdminOrdersService: adminManualRefund refunds wallet, sets REFUNDED status, and creates audit metadata', async () => {
  const { service, ledgerCalls } = makeService();

  const mockTx: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: 'order-1',
                  userId: 'user-1',
                  productId: 'prod-1',
                  price: '50000.00',
                  status: OrderStatus.FULFILLED,
                },
              ]),
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: 'order-1',
                status: OrderStatus.REFUNDED,
              },
            ]),
        }),
      }),
    }),
  };

  const res = await service.adminManualRefund('order-1', 'admin-user', 'Faulty key replacement', false, mockTx);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.refunded, true);
  assert.strictEqual(res.orderId, 'order-1');
  assert.strictEqual(res.refundedAmount, '50000.00');
  assert.strictEqual(ledgerCalls.length, 1);
  assert.strictEqual(ledgerCalls[0][2], LedgerType.PURCHASE_REFUND);
  assert.strictEqual(ledgerCalls[0][3], 'order-1:admin-refund');
  assert.deepStrictEqual(ledgerCalls[0][6], {
    reason: 'Faulty key replacement',
    adminId: 'admin-user',
    source: 'ADMIN_MANUAL_REFUND',
    markCredentialDefective: false,
  });
});

test('[P1] AdminOrdersService: adminManualRefund rejects REFUNDED or PENDING orders with ConflictException', async () => {
  const { service } = makeService();

  const mockTxRefunded: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: 'order-1',
                  userId: 'user-1',
                  status: OrderStatus.REFUNDED,
                },
              ]),
          }),
        }),
      }),
    }),
  };

  const mockTxPending: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: 'order-2',
                  userId: 'user-1',
                  status: OrderStatus.PENDING,
                },
              ]),
          }),
        }),
      }),
    }),
  };

  await assert.rejects(
    () => service.adminManualRefund('order-1', 'admin-user', 'Test', false, mockTxRefunded),
    ConflictException,
  );

  await assert.rejects(
    () => service.adminManualRefund('order-2', 'admin-user', 'Test', false, mockTxPending),
    ConflictException,
  );
});
