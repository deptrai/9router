import { test } from 'node:test';
import assert from 'node:assert';
import { AdminOrdersController } from './admin-orders.controller';
import { BadRequestException } from '@nestjs/common';
import { OrderStatus, ProductSourcingMode } from '@repo/shared-types';

test('[P0] AdminOrdersController has AdminRoleGuard applied at class level', () => {
  const guards = Reflect.getMetadata('__guards__', AdminOrdersController);
  assert.ok(guards, 'Guards should be defined');
  assert.strictEqual(guards.length, 1);
  assert.strictEqual(guards[0].name, 'AdminRoleGuard');
});

test('[P0] AdminOrdersController.listOrders delegates to service with parsed query parameters', async () => {
  let capturedQuery: any;
  const mockService = {
    listAdminOrders: async (query: any) => {
      capturedQuery = query;
      return {
        orders: [
          {
            id: 'order-1',
            userId: 'user-1',
            telegramId: 123456,
            username: 'alice',
            productId: 'prod-1',
            productTitle: 'ChatGPT Plus',
            price: '450000.00',
            status: OrderStatus.SOURCING,
            sourcingMode: ProductSourcingMode.EXTERNAL,
            supplierName: 'Partner Shop A',
            createdAt: '2026-09-12T10:00:00Z',
            fulfilledAt: null,
          },
        ],
        total: 1,
      };
    },
  };

  const controller = new AdminOrdersController(mockService as any);
  const result = await controller.listOrders('20', '0', 'SOURCING', '123456', 'prod-1');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.orders.length, 1);
  assert.strictEqual(result.total, 1);
  assert.strictEqual(capturedQuery.limit, 20);
  assert.strictEqual(capturedQuery.offset, 0);
  assert.strictEqual(capturedQuery.status, OrderStatus.SOURCING);
  assert.strictEqual(capturedQuery.search, '123456');
  assert.strictEqual(capturedQuery.productId, 'prod-1');
});

test('[P0] AdminOrdersController.getOrderDetail returns detailed order payload', async () => {
  const mockDetail = {
    order: {
      id: 'order-1',
      userId: 'user-1',
      productId: 'prod-1',
      status: OrderStatus.FULFILLED,
      price: '100000.00',
      createdAt: '2026-09-12T10:00:00Z',
    },
    customer: {
      id: 'user-1',
      telegramId: 999999,
      username: 'bob',
      firstName: 'Bob',
      lastName: null,
      walletBalance: '50000.00',
    },
    product: {
      id: 'prod-1',
      title: 'Spotify 1M',
      slug: 'spotify-1m',
      price: '100000.00',
      sourcingMode: ProductSourcingMode.IN_HOUSE,
      category: 'Music',
    },
    supplierTraces: [],
    ledgerTransactions: [],
  };

  const mockService = {
    getAdminOrderDetail: async (id: string) => mockDetail,
  };

  const controller = new AdminOrdersController(mockService as any);
  const result = await controller.getOrderDetail('00000000-0000-4000-8000-000000000001');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.order.order.id, 'order-1');
  assert.strictEqual(result.order.customer.telegramId, 999999);
});

test('[P0] AdminOrdersController.refundOrder validates non-empty reason and delegates to service', async () => {
  let capturedArgs: any;
  const mockService = {
    adminManualRefund: async (orderId: string, adminId: string, reason: string, markDefective: boolean) => {
      capturedArgs = { orderId, adminId, reason, markDefective };
      return {
        ok: true,
        refunded: true,
        orderId,
        refundedAmount: '100000.00',
        refundedAt: '2026-09-12T12:00:00Z',
      };
    },
  };

  const controller = new AdminOrdersController(mockService as any);
  const mockReq = { user: { id: 42 } };

  const result = await controller.refundOrder(
    '00000000-0000-4000-8000-000000000001',
    { reason: 'Customer reported invalid key', markCredentialDefective: true },
    mockReq,
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.refunded, true);
  assert.strictEqual(capturedArgs.orderId, '00000000-0000-4000-8000-000000000001');
  assert.strictEqual(capturedArgs.adminId, '42');
  assert.strictEqual(capturedArgs.reason, 'Customer reported invalid key');
  assert.strictEqual(capturedArgs.markDefective, true);
});

test('[P1] AdminOrdersController.refundOrder rejects empty reason with 400 Bad Request', async () => {
  const controller = new AdminOrdersController({} as any);
  const mockReq = { user: { id: 1 } };

  await assert.rejects(
    () => controller.refundOrder('00000000-0000-4000-8000-000000000001', { reason: '' }, mockReq),
    BadRequestException,
  );

  await assert.rejects(
    () => controller.refundOrder('00000000-0000-4000-8000-000000000001', { reason: '   ' }, mockReq),
    BadRequestException,
  );
});
