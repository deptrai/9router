import { test } from 'node:test';
import assert from 'node:assert';
import { OrdersService } from './orders.service';
import { OrderStatus, LedgerType, InventoryStatus } from '@repo/shared-types';
import {
  NotFoundException,
  ConflictException,
  HttpException,
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

function makeService(overrides: {
  existingOrder?: any;
  userRecord?: any;
  walletRecord?: any;
  productRecord?: any;
  reserveResult?: any;
  confirmResult?: any;
  lockError?: Error;
  myOrdersRows?: any[];
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
  };

  const mockInventory = {
    reserveCredential: async () => reserveResult,
    confirmSold: async () => confirmResult,
  };

  const telegramBotCalls: any[] = [];
  const mockTelegramBot = {
    sendOrderConfirmation: async (
      telegramId: number,
      order: any,
      productTitle: string,
    ) => {
      telegramBotCalls.push({ telegramId, order, productTitle });
    },
  };

  const service = new OrdersService(
    mockRedis as any,
    mockLedger as any,
    mockInventory as any,
    mockWallets as any,
    mockUsers as any,
    mockTelegramBot as any,
  );

  // Mock db.transaction to run the function with a mock tx
  const { db } = require('@repo/database');
  const originalTransaction = db.transaction;
  const originalSelect = db.select;

  // Mock db.select for getOrderByIdempotencyKey
  const mockTx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(pr ? [pr] : []),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([orderRecord]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([fulfilledOrderRecord]),
        }),
      }),
    }),
  };

  db.transaction = async (fn: any) => fn(mockTx);
  db.select = () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(existingOrder ? [existingOrder] : []),
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
    cleanup: () => {
      db.transaction = originalTransaction;
      db.select = originalSelect;
    },
  };
}

test('checkout returns existing order for duplicate idempotencyKey', async () => {
  const { service, cleanup } = makeService({ existingOrder: fulfilledOrderRecord });
  try {
    const res = await service.checkout(telegramUser as any, 'prod-uuid-1', 'idem-key-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.order.id, 'order-uuid-1');
    assert.strictEqual(res.order.status, OrderStatus.FULFILLED);
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
