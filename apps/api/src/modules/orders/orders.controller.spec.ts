import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert';
import { OrdersController } from './orders.controller';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { OrderStatus } from '@repo/shared-types';
import type { OrderDto } from '@repo/shared-types';

const telegramUser = { id: 123456, firstName: 'Alice' };

const mockOrder = {
  id: 'order-uuid-1',
  userId: 'user-uuid-1',
  productId: 'prod-uuid-1',
  status: OrderStatus.FULFILLED,
  price: '200000.00',
  deliveredCredential: 'PLAINTEXT-KEY-123',
  idempotencyKey: 'idem-key-1',
  createdAt: new Date().toISOString(),
  fulfilledAt: new Date().toISOString(),
};

test('OrdersController has TelegramAuthGuard applied at class level', () => {
  const guards = Reflect.getMetadata('__guards__', OrdersController);
  assert.ok(Array.isArray(guards));
  assert.ok(guards.includes(TelegramAuthGuard));
});

test('checkout returns CheckoutResponseDto on success', async () => {
  const mockService = {
    checkout: async (user: any, productId: string, key: string) => {
      assert.strictEqual(productId, 'prod-uuid-1');
      assert.strictEqual(key, 'idem-key-1');
      return { ok: true, order: mockOrder, deliveredCredential: 'PLAINTEXT-KEY-123' };
    },
  } as any;

  const controller = new OrdersController(mockService);
  const res = await controller.checkout(telegramUser as any, {
    productId: 'prod-uuid-1',
    idempotencyKey: 'idem-key-1',
  });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.order.status, OrderStatus.FULFILLED);
  assert.strictEqual(res.deliveredCredential, 'PLAINTEXT-KEY-123');
});

test('checkout throws BadRequestException for missing productId', async () => {
  const controller = new OrdersController({} as any);
  await assert.rejects(
    () => controller.checkout(telegramUser as any, { idempotencyKey: 'k' } as any),
    (err: any) => err?.getResponse()?.errorCode === 'INVALID_CHECKOUT_PAYLOAD',
  );
});

test('checkout throws BadRequestException for missing idempotencyKey', async () => {
  const controller = new OrdersController({} as any);
  await assert.rejects(
    () => controller.checkout(telegramUser as any, { productId: 'prod-1' } as any),
    (err: any) => err?.getResponse()?.errorCode === 'INVALID_CHECKOUT_PAYLOAD',
  );
});

test('checkout throws BadRequestException for idempotencyKey > 100 chars', async () => {
  const controller = new OrdersController({} as any);
  await assert.rejects(
    () =>
      controller.checkout(telegramUser as any, {
        productId: 'prod-1',
        idempotencyKey: 'x'.repeat(101),
      }),
    (err: any) => err?.getResponse()?.errorCode === 'INVALID_CHECKOUT_PAYLOAD',
  );
});

test('GET /api/orders returns orders array on success', async () => {
  const mockService = {
    getMyOrders: async (user: any) => {
      assert.strictEqual(user.id, telegramUser.id);
      return [mockOrder] as OrderDto[];
    },
  } as any;
  const controller = new OrdersController(mockService);
  const res = await controller.getMyOrders(telegramUser as any);
  assert.ok(Array.isArray(res));
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].id, mockOrder.id);
  assert.strictEqual(res[0].status, OrderStatus.FULFILLED);
});

test('getMyOrders delegates to ordersService.getMyOrders', async () => {
  let calledWith: any = null;
  const mockService = {
    getMyOrders: async (user: any) => {
      calledWith = user;
      return [];
    },
  } as any;
  const controller = new OrdersController(mockService);
  await controller.getMyOrders(telegramUser as any);
  assert.deepStrictEqual(calledWith, telegramUser);
});

test('getMyOrders returns empty array when no orders', async () => {
  const mockService = {
    getMyOrders: async () => [],
  } as any;
  const controller = new OrdersController(mockService);
  const res = await controller.getMyOrders(telegramUser as any);
  assert.deepStrictEqual(res, []);
});

test('GET /api/orders/:id returns OrderDto on success', async () => {
  const mockService = {
    getOrderByIdForUser: async (user: any, orderId: string) => {
      assert.strictEqual(user.id, telegramUser.id);
      assert.strictEqual(orderId, 'order-uuid-1');
      return mockOrder as OrderDto;
    },
  } as any;
  const controller = new OrdersController(mockService);
  const res = await controller.getOrderById(telegramUser as any, 'order-uuid-1');
  assert.strictEqual(res.id, 'order-uuid-1');
  assert.strictEqual(res.status, OrderStatus.FULFILLED);
});

test('GET /api/orders/:id throws NotFoundException when order not found', async () => {
  const mockService = {
    getOrderByIdForUser: async () => null,
  } as any;
  const controller = new OrdersController(mockService);
  await assert.rejects(
    () => controller.getOrderById(telegramUser as any, 'missing-id'),
    (err: any) => err?.getResponse()?.errorCode === 'ORDER_NOT_FOUND',
  );
});

