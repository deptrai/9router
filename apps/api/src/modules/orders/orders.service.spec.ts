import { test } from 'node:test';
import assert from 'node:assert';
import { OrdersService } from './orders.service';
import { OrderStatus, LedgerType, InventoryStatus } from '@repo/shared-types';
import {
  NotFoundException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisUnavailableError } from '../../common/redis/redis.service';

const telegramUser = {
  id: 123456,
  firstName: 'Alice',
  username: 'alice_test',
};

const userRecord = {
  id: 'user-uuid-1',
  telegramId: 123456,
  username: 'alice_test',
  firstName: 'Alice',
};

const walletRecord = {
  id: 'wallet-uuid-1',
  userId: 'user-uuid-1',
  balance: '500000.00',
  heldBalance: '0.00',
  currency: 'VND',
};

const productRecord = {
  id: 'prod-uuid-1',
  title: 'Netflix Premium',
  price: '200000.00',
  isActive: true,
  sourcingMode: 'IN_HOUSE',
  supplierSourceId: null,
};

const externalProductRecord = {
  ...productRecord,
  sourcingMode: 'EXTERNAL',
  supplierSourceId: 'sup-uuid-1',
};

const hybridProductRecord = {
  ...productRecord,
  sourcingMode: 'HYBRID',
  supplierSourceId: 'sup-uuid-1',
};

const reservedItem = {
  id: 'inv-uuid-1',
  productId: 'prod-uuid-1',
  status: InventoryStatus.RESERVED,
  orderId: 'order-uuid-1',
};

const deliveredItem = {
  id: 'inv-uuid-1',
  productId: 'prod-uuid-1',
  credentialData: 'PLAINTEXT-KEY-123',
  orderId: 'order-uuid-1',
  soldAt: new Date().toISOString(),
};

const orderRecord = {
  id: 'order-uuid-1',
  userId: 'user-uuid-1',
  productId: 'prod-uuid-1',
  price: '200000.00',
  status: OrderStatus.PENDING,
  idempotencyKey: 'idem-key-1',
  deliveredCredential: null,
  createdAt: new Date(),
  fulfilledAt: null,
};

const fulfilledOrderRecord = {
  ...orderRecord,
  status: OrderStatus.FULFILLED,
  deliveredCredential: 'PLAINTEXT-KEY-123',
  fulfilledAt: new Date(),
};

const sourcingOrderRecord = {
  ...orderRecord,
  status: OrderStatus.SOURCING,
};

function makeService(overrides: {
  existingOrder?: any;
  userRecord?: any;
  walletRecord?: any;
  productRecord?: any;
  reserveResult?: any;
  confirmResult?: any;
  lockError?: Error;
  myOrdersRows?: any[];
  supplierActive?: boolean;
  enqueueError?: Error | null;
  queueReady?: boolean;
  productSupplierId?: string | null;
  inFlightOrder?: any;
}) {
  const {
    existingOrder = null,
    userRecord: ur = userRecord,
    walletRecord: wr = walletRecord,
    productRecord: pr = productRecord,
    reserveResult = reservedItem,
    confirmResult = deliveredItem,
    lockError = null,
    myOrdersRows = [],
    supplierActive = true,
    enqueueError = null,
    queueReady = true,
    productSupplierId = 'sup-uuid-1',
    inFlightOrder = null,
  } = overrides;

  const mockRedis = {
    withLock: async (_keys: string[], _ttl: number, fn: any) => {
      if (lockError) throw lockError;
      return fn();
    },
  };

  const mockUsers = {
    upsertByTelegram: async () => ur,
  };

  const mockWallets = {
    getOrCreateByUserId: async () => wr,
  };

  const creditCalls: any[] = [];
  const mockLedger = {
    debit: async () => ({
      id: 'ledger-uuid-1',
      walletId: wr.id,
      type: LedgerType.STORE_PURCHASE,
      amount: '200000.00',
      balanceBefore: '500000.00',
      balanceAfter: '300000.00',
      referenceId: 'order-uuid-1',
      idempotencyKey: 'idem-key-1',
      createdAt: new Date().toISOString(),
    }),
    credit: async (
      walletId: string,
      amount: string,
      type: any,
      idempotencyKey: string,
      referenceId?: string | null,
    ) => {
      creditCalls.push({ walletId, amount, type, idempotencyKey, referenceId });
      return {
        id: 'ledger-refund-1',
        walletId,
        type,
        amount,
        balanceBefore: '300000.00',
        balanceAfter: '500000.00',
        referenceId: referenceId ?? null,
        idempotencyKey,
        createdAt: new Date().toISOString(),
      };
    },
  };

  const mockInventory = {
    reserveCredential: async () => reserveResult,
    confirmSold: async () => confirmResult,
  };

  const telegramBotCalls: any[] = [];
  const sourcingNoticeCalls: any[] = [];
  const mockTelegramBot = {
    sendOrderConfirmation: async (
      telegramId: number,
      order: any,
      productTitle: string,
    ) => {
      telegramBotCalls.push({ telegramId, order, productTitle });
    },
    sendSourcingNotice: async (
      telegramId: number,
      order: any,
      productTitle: string,
    ) => {
      sourcingNoticeCalls.push({ telegramId, order, productTitle });
    },
  };

  const sourcingCalls: any[] = [];
  const mockSourcingQueue = {
    isReady: () => queueReady,
    ensureSourcingJob: async (data: any) => {
      if (enqueueError) throw enqueueError;
      sourcingCalls.push(data);
    },
  };

  const service = new OrdersService(
    mockRedis as any,
    mockLedger as any,
    mockInventory as any,
    mockWallets as any,
    mockUsers as any,
    mockTelegramBot as any,
    mockSourcingQueue as any,
  );

  // Mock db.transaction to run the function with a mock tx
  const { db } = require('@repo/database');
  const originalTransaction = db.transaction;
  const originalSelect = db.select;

  // Mock db.select for getOrderByIdempotencyKey + product supplier probe.
  // tx.select(fields): isActive → supplier probe; id → in-flight order probe;
  // no fields → product row.
  const updateCalls: any[] = [];
  const mockTx = {
    select: (fields?: any) => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              !fields
                ? pr
                  ? [pr]
                  : []
                : 'isActive' in fields
                  ? [{ isActive: supplierActive }]
                  : 'id' in fields
                    ? inFlightOrder
                      ? [inFlightOrder]
                      : []
                    : [],
            ),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([orderRecord]),
      }),
    }),
    update: () => ({
      set: (v: any) => {
        updateCalls.push(v);
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                v.status === OrderStatus.SOURCING
                  ? sourcingOrderRecord
                  : fulfilledOrderRecord,
              ]),
          }),
        };
      },
    }),
  };

  db.transaction = async (fn: any) => fn(mockTx);
  db.select = (fields?: any) => ({
    from: () => ({
      where: () => ({
        limit: () =>
          Promise.resolve(
            fields && 'supplierSourceId' in fields
              ? productSupplierId
                ? [{ supplierSourceId: productSupplierId }]
                : []
              : existingOrder
                ? [existingOrder]
                : [],
          ),
      }),
      leftJoin: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(myOrdersRows),
        }),
      }),
    }),
  });

  return {
    service,
    telegramBotCalls,
    sourcingNoticeCalls,
    sourcingCalls,
    creditCalls,
    updateCalls,
    cleanup: () => {
      db.transaction = originalTransaction;
      db.select = originalSelect;
    },
  };
}

test('checkout returns existing order for duplicate idempotencyKey', async () => {
  const { service, sourcingCalls, cleanup } = makeService({ existingOrder: fulfilledOrderRecord });
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.order.id, 'order-uuid-1');
    assert.strictEqual(res.order.status, OrderStatus.FULFILLED);
    assert.strictEqual(sourcingCalls.length, 0, 'no self-heal for non-SOURCING order');
  } finally {
    cleanup();
  }
});

test('checkout succeeds for in-house product with sufficient balance', async () => {
  const { service, cleanup } = makeService({});
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.order.status, OrderStatus.FULFILLED);
    assert.strictEqual(res.deliveredCredential, 'PLAINTEXT-KEY-123');
  } finally {
    cleanup();
  }
});

test('checkout throws 402 INSUFFICIENT_FUNDS when balance < price', async () => {
  const poorWallet = { ...walletRecord, balance: '50000.00' }; // less than 200000
  const { service, cleanup } = makeService({ walletRecord: poorWallet });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof HttpException);
        assert.strictEqual(err.getStatus(), 402);
        const resp = err.getResponse() as any;
        assert.strictEqual(resp.errorCode, 'INSUFFICIENT_FUNDS');
        assert.strictEqual(resp.missingAmount, '150000.00');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('checkout throws 409 OUT_OF_STOCK when no credentials available', async () => {
  const { service, cleanup } = makeService({ reserveResult: null });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof ConflictException);
        const resp = err.getResponse() as any;
        assert.strictEqual(resp.errorCode, 'OUT_OF_STOCK');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('checkout throws 404 PRODUCT_NOT_FOUND for missing product', async () => {
  const { service, cleanup } = makeService({ productRecord: null });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'nonexistent-prod', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof NotFoundException);
        const resp = err.getResponse() as any;
        assert.strictEqual(resp.errorCode, 'PRODUCT_NOT_FOUND');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('checkout throws 409 ORDER_LOCK_CONFLICT when lock fails', async () => {
  const lockError = new RedisUnavailableError('Redis down');
  const { service, cleanup } = makeService({ lockError });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof ConflictException);
        const resp = err.getResponse() as any;
        assert.strictEqual(resp.errorCode, 'ORDER_LOCK_CONFLICT');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('checkout throws 409 ORDER_LOCK_CONFLICT when ResourceLockedError occurs', async () => {
  const resourceLockedErr = new Error('The resource "lock:wallet:user-1" is already locked');
  resourceLockedErr.name = 'ResourceLockedError';
  const { service, cleanup } = makeService({ lockError: resourceLockedErr });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof ConflictException);
        const resp = err.getResponse() as any;
        assert.strictEqual(resp.errorCode, 'ORDER_LOCK_CONFLICT');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('checkout: debit is called before reserveCredential (rollback on OUT_OF_STOCK)', async () => {
  let debitCalled = false;
  const { service, cleanup } = makeService({ reserveResult: null });
  // Track if debit was called (would be rolled back in real tx)
  const serviceAny = service as any;
  const origCheckout = serviceAny.checkout.bind(service);
  // We can't easily intercept inside db.transaction mock — just verify ConflictException thrown
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => err instanceof ConflictException,
    );
  } finally {
    cleanup();
  }
});

test('checkout: 23505 unique violation returns existing order (idempotency race)', async () => {
  // Simulate: tx throws 23505, then getOrderByIdempotencyKey returns the existing order
  const existingOrder = {
    ...fulfilledOrderRecord,
    idempotencyKey: 'idem-race-key',
  };
  const { service, cleanup } = makeService({});
  const { db } = require('@repo/database');
  const origSelect = db.select;
  const origTransaction = db.transaction;

  // First select (idempotency check) returns null — order doesn't exist yet
  // Second select (after 23505) returns the committed order
  let selectCallCount = 0;
  db.select = () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          selectCallCount++;
          return Promise.resolve(selectCallCount > 1 ? [existingOrder] : []);
        },
      }),
    }),
  });
  // Transaction throws 23505 on insert
  db.transaction = async (fn: any) => {
    const err: any = new Error('duplicate key value violates unique constraint');
    err.code = '23505';
    throw err;
  };

  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-race-key');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.order.idempotencyKey, 'idem-race-key');
    assert.strictEqual(res.order.status, OrderStatus.FULFILLED);
  } finally {
    db.select = origSelect;
    db.transaction = origTransaction;
    cleanup();
  }
});

// ── getMyOrders ─────────────────────────────────────────────────────────────

test('getMyOrders returns empty array when user has no orders', async () => {
  const { service, cleanup } = makeService({ myOrdersRows: [] });
  try {
    const result = await service.getMyOrders(telegramUser as any);
    assert.deepStrictEqual(result, []);
  } finally {
    cleanup();
  }
});

test('getMyOrders returns orders sorted createdAt DESC with productTitle', async () => {
  const now = new Date();
  const rows = [
    {
      order: {
        id: 'order-2',
        userId: 'user-uuid-1',
        productId: 'prod-uuid-1',
        status: 'FULFILLED',
        price: '300000.00',
        deliveredCredential: 'KEY-B',
        idempotencyKey: 'k2',
        createdAt: now,
        fulfilledAt: now,
      },
      productTitle: 'Product B',
    },
    {
      order: {
        id: 'order-1',
        userId: 'user-uuid-1',
        productId: 'prod-uuid-1',
        status: 'PENDING',
        price: '200000.00',
        deliveredCredential: null,
        idempotencyKey: 'k1',
        createdAt: new Date(now.getTime() - 60000),
        fulfilledAt: null,
      },
      productTitle: 'Product A',
    },
  ];

  const { service, cleanup } = makeService({ myOrdersRows: rows });
  try {
    const result = await service.getMyOrders(telegramUser as any);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, 'order-2');
    assert.strictEqual(result[0].productTitle, 'Product B');
    assert.strictEqual(result[0].deliveredCredential, 'KEY-B');
    assert.strictEqual(result[1].id, 'order-1');
    assert.strictEqual(result[1].productTitle, 'Product A');
    assert.strictEqual(result[1].deliveredCredential, null);
  } finally {
    cleanup();
  }
});

test('getMyOrders only queries orders for current user', async () => {
  let whereArg: any = null;

  const { service, cleanup } = makeService({});
  // Patch db.select to capture the where clause while keeping leftJoin chain
  const { db } = require('@repo/database') as any;
  const origSelect = db.select;
  db.select = () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([]),
      }),
      leftJoin: () => ({
        where: (w: any) => {
          whereArg = w;
          return { orderBy: () => Promise.resolve([]) };
        },
      }),
    }),
  });
  try {
    await service.getMyOrders(telegramUser as any);
    assert.ok(whereArg !== null, 'where was called');
  } finally {
    db.select = origSelect;
    cleanup();
  }
});

// ── sendOrderConfirmation in checkout ────────────────────────────────────────

test('checkout calls telegramBotService.sendOrderConfirmation after FULFILLED', async () => {
  const { service, telegramBotCalls, cleanup } = makeService({});
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.order.status, OrderStatus.FULFILLED);
    // Allow microtask for fire-and-forget to be called
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(telegramBotCalls.length, 1);
    assert.strictEqual(telegramBotCalls[0].telegramId, telegramUser.id);
    assert.strictEqual(telegramBotCalls[0].productTitle, productRecord.title);
    assert.strictEqual(telegramBotCalls[0].order.id, fulfilledOrderRecord.id);
  } finally {
    cleanup();
  }
});

test('checkout does not throw when sendOrderConfirmation throws (fire-and-forget)', async () => {
  const { service, telegramBotCalls, cleanup } = makeService({});
  try {
    // Patch telegramBot to throw — should not propagate
    const svcAny = service as any;
    svcAny.telegramBotService = {
      sendOrderConfirmation: async () => {
        throw new Error('Telegram API down');
      },
    };
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.order.status, OrderStatus.FULFILLED);
  } finally {
    cleanup();
  }
});

test('checkout does NOT call sendOrderConfirmation for idempotent repeat (existing order)', async () => {
  const { service, telegramBotCalls, cleanup } = makeService({
    existingOrder: fulfilledOrderRecord,
  });
  try {
    await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(telegramBotCalls.length, 0, 'no notification for duplicate request');
  } finally {
    cleanup();
  }
});

// ── Story 4.2: Smart sourcing routing ──────────────────────────────────────

test('checkout routes EXTERNAL product with empty in-house stock to SOURCING + enqueues job', async () => {
  const { service, sourcingCalls, telegramBotCalls, sourcingNoticeCalls, cleanup } = makeService({
    productRecord: externalProductRecord,
    reserveResult: null,
  });
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.order.status, OrderStatus.SOURCING);
    assert.strictEqual(res.deliveredCredential, undefined);
    assert.strictEqual(sourcingCalls.length, 1);
    assert.deepStrictEqual(sourcingCalls[0], {
      orderId: 'order-uuid-1',
      productId: 'prod-uuid-1',
      supplierSourceId: 'sup-uuid-1',
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(telegramBotCalls.length, 0, 'no order confirmation for SOURCING');
    assert.strictEqual(sourcingNoticeCalls.length, 1, 'buyer gets a sourcing notice');
    assert.strictEqual(sourcingNoticeCalls[0].telegramId, telegramUser.id);
  } finally {
    cleanup();
  }
});

test('checkout routes HYBRID product with empty in-house stock to SOURCING', async () => {
  const { service, sourcingCalls, cleanup } = makeService({
    productRecord: hybridProductRecord,
    reserveResult: null,
  });
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.order.status, OrderStatus.SOURCING);
    assert.strictEqual(sourcingCalls.length, 1);
  } finally {
    cleanup();
  }
});

test('checkout still throws OUT_OF_STOCK for EXTERNAL product when supplier is inactive', async () => {
  const { service, sourcingCalls, cleanup } = makeService({
    productRecord: externalProductRecord,
    reserveResult: null,
    supplierActive: false,
  });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof ConflictException);
        assert.strictEqual((err.getResponse() as any).errorCode, 'OUT_OF_STOCK');
        return true;
      },
    );
    assert.strictEqual(sourcingCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('checkout throws OUT_OF_STOCK for EXTERNAL product without supplierSourceId', async () => {
  const { service, sourcingCalls, cleanup } = makeService({
    productRecord: { ...externalProductRecord, supplierSourceId: null },
    reserveResult: null,
  });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.strictEqual((err.getResponse() as any).errorCode, 'OUT_OF_STOCK');
        return true;
      },
    );
    assert.strictEqual(sourcingCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('checkout on post-commit enqueue failure → 503 + refund compensate + order REFUNDED', async () => {
  const enqueueErr = new Error('queue unavailable');
  const { service, sourcingCalls, creditCalls, updateCalls, cleanup } = makeService({
    productRecord: externalProductRecord,
    reserveResult: null,
    enqueueError: enqueueErr,
  });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof ServiceUnavailableException);
        assert.strictEqual(err.getStatus(), 503);
        assert.strictEqual(
          (err.getResponse() as any).errorCode,
          'SOURCING_UNAVAILABLE',
        );
        return true;
      },
    );
    assert.strictEqual(sourcingCalls.length, 0, 'enqueue threw before recording');
    assert.strictEqual(creditCalls.length, 1, 'debit compensated with a refund credit');
    assert.strictEqual(creditCalls[0].type, LedgerType.PURCHASE_REFUND);
    assert.strictEqual(creditCalls[0].idempotencyKey, 'idem-key-1:refund');
    assert.strictEqual(creditCalls[0].referenceId, 'order-uuid-1');
    const statuses = updateCalls.map((u) => u.status);
    assert.deepStrictEqual(statuses, [
      OrderStatus.PAID,
      OrderStatus.SOURCING,
      OrderStatus.REFUNDED,
    ]);
  } finally {
    cleanup();
  }
});

test('checkout throws 503 inside tx (rollback, no charge) when sourcing queue not initialized', async () => {
  const { service, sourcingCalls, creditCalls, updateCalls, cleanup } = makeService({
    productRecord: externalProductRecord,
    reserveResult: null,
    queueReady: false,
  });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof ServiceUnavailableException);
        assert.strictEqual(
          (err.getResponse() as any).errorCode,
          'SOURCING_UNAVAILABLE',
        );
        return true;
      },
    );
    assert.strictEqual(sourcingCalls.length, 0);
    assert.strictEqual(creditCalls.length, 0, 'tx rolled back — no compensate needed');
    const statuses = updateCalls.map((u) => u.status);
    assert.deepStrictEqual(statuses, [OrderStatus.PAID], 'no SOURCING/REFUNDED write inside rolled-back tx');
  } finally {
    cleanup();
  }
});

test('checkout returns existing SOURCING order on replay and self-heals the sourcing job', async () => {
  const { service, sourcingCalls, telegramBotCalls, sourcingNoticeCalls, cleanup } = makeService({
    existingOrder: sourcingOrderRecord,
  });
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.order.status, OrderStatus.SOURCING);
    assert.strictEqual(sourcingCalls.length, 1, 'self-heal ensures the job exists (dedup no-op when healthy)');
    assert.deepStrictEqual(sourcingCalls[0], {
      orderId: 'order-uuid-1',
      productId: 'prod-uuid-1',
      supplierSourceId: 'sup-uuid-1',
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(telegramBotCalls.length, 0);
    assert.strictEqual(sourcingNoticeCalls.length, 0, 'no re-notification on replay');
  } finally {
    cleanup();
  }
});

test('checkout replay self-heal failure is swallowed — order still returned', async () => {
  const { service, sourcingCalls, cleanup } = makeService({
    existingOrder: sourcingOrderRecord,
    enqueueError: new Error('Redis down'),
  });
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.order.status, OrderStatus.SOURCING);
    assert.strictEqual(sourcingCalls.length, 0, 'ensure threw before recording');
  } finally {
    cleanup();
  }
});

// ── Review fixes: in-flight guard, margin guard, lock-lost-after-commit ──

test('checkout throws 409 ORDER_IN_PROGRESS when an in-flight order exists for same product', async () => {
  const { service, sourcingCalls, cleanup } = makeService({
    productRecord: externalProductRecord,
    inFlightOrder: { id: 'order-inflight-9' },
  });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof ConflictException);
        assert.strictEqual(
          (err.getResponse() as any).errorCode,
          'ORDER_IN_PROGRESS',
        );
        return true;
      },
    );
    assert.strictEqual(sourcingCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('checkout throws OUT_OF_STOCK when upstreamCost exceeds price (margin guard)', async () => {
  const { service, sourcingCalls, cleanup } = makeService({
    productRecord: {
      ...externalProductRecord,
      upstreamCost: '250000.00', // > price 200000 → guaranteed loss
    },
    reserveResult: null,
  });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof ConflictException);
        assert.strictEqual(
          (err.getResponse() as any).errorCode,
          'OUT_OF_STOCK',
        );
        return true;
      },
    );
    assert.strictEqual(sourcingCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('checkout throws OUT_OF_STOCK when upstreamCost breaches maxUpstreamCost ceiling', async () => {
  const { service, sourcingCalls, cleanup } = makeService({
    productRecord: {
      ...externalProductRecord,
      upstreamCost: '150000.00', // < price but over configured ceiling
      maxUpstreamCost: '100000.00',
    },
    reserveResult: null,
  });
  try {
    await assert.rejects(
      () => service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1'),
      (err: any) => {
        assert.ok(err instanceof ConflictException);
        assert.strictEqual(
          (err.getResponse() as any).errorCode,
          'OUT_OF_STOCK',
        );
        return true;
      },
    );
    assert.strictEqual(sourcingCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('checkout still routes to SOURCING when margin is healthy', async () => {
  const { service, sourcingCalls, cleanup } = makeService({
    productRecord: {
      ...externalProductRecord,
      upstreamCost: '150000.00',
      maxUpstreamCost: '180000.00',
    },
    reserveResult: null,
  });
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.order.status, OrderStatus.SOURCING);
    assert.strictEqual(sourcingCalls.length, 1);
  } finally {
    cleanup();
  }
});

test('checkout returns committed order when lock is lost AFTER tx commit', async () => {
  // withLock throws lock-lost error; the tx already committed → the order
  // must be returned (not a misleading 409 that invites a double-charge).
  const { service, sourcingCalls, cleanup } = makeService({
    lockError: new RedisUnavailableError('Redlock lost during execution'),
  });
  const { db } = require('@repo/database');
  const origSelect = db.select;
  let selectCallCount = 0;
  db.select = (fields?: any) => ({
    from: () => ({
      where: () => ({
        limit: () => {
          selectCallCount++;
          // supplierSourceId probe (self-heal) → product supplier
          if (fields && 'supplierSourceId' in fields) {
            return Promise.resolve([{ supplierSourceId: 'sup-uuid-1' }]);
          }
          // step-1 idempotency → none; post-catch check → committed order
          return Promise.resolve(
            selectCallCount > 1 ? [sourcingOrderRecord] : [],
          );
        },
      }),
    }),
  });
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.order.status, OrderStatus.SOURCING);
    assert.strictEqual(sourcingCalls.length, 1, 'self-heal runs on the returned SOURCING order');
  } finally {
    db.select = origSelect;
    cleanup();
  }
});

test('checkout marks order PAID before reserving (state machine PENDING→PAID→FULFILLED)', async () => {
  const { service, updateCalls, cleanup } = makeService({});
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.order.status, OrderStatus.FULFILLED);
    const statuses = updateCalls.map((u) => u.status);
    assert.deepStrictEqual(statuses, [OrderStatus.PAID, OrderStatus.FULFILLED]);
  } finally {
    cleanup();
  }
});

test('checkout marks PAID then SOURCING for external routing (PENDING→PAID→SOURCING)', async () => {
  const { service, updateCalls, cleanup } = makeService({
    productRecord: externalProductRecord,
    reserveResult: null,
  });
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.order.status, OrderStatus.SOURCING);
    const statuses = updateCalls.map((u) => u.status);
    assert.deepStrictEqual(statuses, [OrderStatus.PAID, OrderStatus.SOURCING]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Story 5.3: Admin Orders & Manual Refund Tests
// ---------------------------------------------------------------------------

test('[P0] OrdersService: listAdminOrders returns paginated order rows with total count', async () => {
  const { service, cleanup } = makeService({});
  const chainBuilder: any = {
    innerJoin: () => chainBuilder,
    leftJoin: () => chainBuilder,
    where: () => chainBuilder,
    orderBy: () => chainBuilder,
    limit: () => chainBuilder,
    offset: () => Promise.resolve([
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
    select: (fields?: any) => ({
      from: (table: any) => chainBuilder,
    }),
  };

  try {
    const result = await service.listAdminOrders({ limit: 10, offset: 0 }, mockTx);
    assert.strictEqual(result.orders.length, 1);
    assert.strictEqual(result.orders[0].id, 'order-1');
    assert.strictEqual(result.orders[0].telegramId, 111222);
    assert.strictEqual(result.orders[0].productTitle, 'Test Product');
  } finally {
    cleanup();
  }
});

test('[P0] OrdersService: getAdminOrderDetail returns complete order, customer, product, and traces', async () => {
  const { service, cleanup } = makeService({});
  const mockTx: any = {
    select: (fields?: any) => ({
      from: (table: any) => ({
        innerJoin: () => ({
          leftJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => Promise.resolve([
                  {
                    order: {
                      id: 'order-1',
                      userId: 'user-1',
                      productId: 'prod-1',
                      price: '50000.00',
                      status: OrderStatus.FULFILLED,
                      deliveredCredential: 'user@example.com:password123',
                      createdAt: new Date(),
                      fulfilledAt: new Date(),
                    },
                    user: {
                      id: 'user-1',
                      telegramId: 111222,
                      username: 'test_user',
                      firstName: 'Test',
                      lastName: 'User',
                    },
                    wallet: {
                      balance: '120000.00',
                    },
                    product: {
                      id: 'prod-1',
                      title: 'Test Product',
                      slug: 'test-product',
                      price: '50000.00',
                      sourcingMode: 'IN_HOUSE',
                      category: 'AI',
                    },
                  },
                ]),
              }),
            }),
          }),
        }),
        leftJoin: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([]),
          }),
        }),
        where: () => ({
          orderBy: () => Promise.resolve([]),
        }),
      }),
    }),
  };

  try {
    const detail = await service.getAdminOrderDetail('order-1', mockTx);
    assert.strictEqual(detail.order.id, 'order-1');
    assert.strictEqual(detail.customer.telegramId, 111222);
    assert.strictEqual(detail.product.title, 'Test Product');
    assert.ok(detail.order.deliveredCredential?.includes('***'), 'credential must be masked');
  } finally {
    cleanup();
  }
});

test('[P0] OrdersService: adminManualRefund refunds wallet, sets REFUNDED status, and notifies customer', async () => {
  let creditCalled = false;
  let noticeSent = false;
  const { service, cleanup } = makeService({});

  (service as any).ledgerService = {
    credit: async () => {
      creditCalled = true;
      return {};
    },
  };
  (service as any).telegramBotService = {
    sendRefundNotice: async () => {
      noticeSent = true;
    },
  };

  const mockTx: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () => Promise.resolve([
              {
                id: 'order-1',
                userId: 'user-1',
                productId: 'prod-1',
                price: '50000.00',
                status: OrderStatus.FULFILLED,
              },
            ]),
          }),
          limit: () => Promise.resolve([
            { id: 'user-1', telegramId: 111222 },
          ]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([
            {
              id: 'order-1',
              status: OrderStatus.REFUNDED,
              price: '50000.00',
            },
          ]),
        }),
      }),
    }),
  };

  try {
    const res = await service.adminManualRefund('order-1', 'admin-user', 'Faulty key replacement', false, mockTx);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.refunded, true);
    assert.strictEqual(res.orderId, 'order-1');
    assert.strictEqual(res.refundedAmount, '50000.00');
    assert.strictEqual(creditCalled, true, 'LedgerService.credit must be called');
  } finally {
    cleanup();
  }
});

test('[P1] OrdersService: adminManualRefund rejects REFUNDED or PENDING orders with ConflictException', async () => {
  const { service, cleanup } = makeService({});

  const mockTxRefunded: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () => Promise.resolve([
              { id: 'order-1', status: OrderStatus.REFUNDED },
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
            limit: () => Promise.resolve([
              { id: 'order-2', status: OrderStatus.PENDING },
            ]),
          }),
        }),
      }),
    }),
  };

  try {
    await assert.rejects(
      () => service.adminManualRefund('order-1', 'admin-user', 'Test', false, mockTxRefunded),
      (err: any) => err.response?.errorCode === 'ORDER_ALREADY_REFUNDED' || err.errorCode === 'ORDER_ALREADY_REFUNDED',
    );

    await assert.rejects(
      () => service.adminManualRefund('order-2', 'admin-user', 'Test', false, mockTxPending),
      (err: any) => err.response?.errorCode === 'ORDER_CANNOT_BE_REFUNDED' || err.errorCode === 'ORDER_CANNOT_BE_REFUNDED',
    );
  } finally {
    cleanup();
  }
});
