import { test } from 'node:test';
import assert from 'node:assert';
import { UnrecoverableError } from 'bullmq';
import {
  db,
  orders,
  products,
  supplierSources,
  supplierOrders,
  wallets,
  users,
} from '@repo/database';
import {
  OrderStatus,
  SupplierOrderStatus,
  LedgerType,
} from '@repo/shared-types';
import { SourcingExecutorService } from './sourcing-executor.service';
import { AdapterRegistryService } from './adapters/adapter.registry';
import {
  SupplierTerminalError,
  SupplierRetryableError,
} from './adapters/supplier-adapter';

const testOrder = {
  id: 'order-1',
  userId: 'user-1',
  productId: 'prod-1',
  price: '100000.00',
  status: OrderStatus.SOURCING,
  idempotencyKey: 'idem-1',
  deliveredCredential: null,
  createdAt: new Date(),
  fulfilledAt: null,
};

const testProduct = {
  id: 'prod-1',
  title: 'Test Product',
  slug: 'test-product',
  price: '100000.00',
  maxUpstreamCost: '80000.00',
  sourcingMode: 'EXTERNAL',
  supplierSourceId: 'sup-1',
  isActive: true,
};

const testSupplier = {
  id: 'sup-1',
  name: 'Test Supplier',
  type: 'CONFIG_POOL',
  targetUrl: null,
  configCredentials: {
    credentialPool: ['KEY-AAA', 'KEY-BBB'],
  },
  isActive: true,
};

const testUser = {
  id: 'user-1',
  telegramId: 999111,
  username: 'testbuyer',
};

const testWallet = {
  id: 'wallet-1',
  userId: 'user-1',
  balance: '500000.00',
};

interface MockSetupOptions {
  orderRow?: any;
  productRow?: any;
  supplierRow?: any;
  userRow?: any;
  walletRow?: any;
  adapter?: any;
  upstreamCost?: string;
  fetchCostError?: Error;
  fulfillRowsAffected?: number;
  refundRowsAffected?: number;
  telegramError?: Error;
}

function createHarness(opts: MockSetupOptions = {}) {
  const {
    orderRow = testOrder,
    productRow = testProduct,
    supplierRow = testSupplier,
    userRow = testUser,
    walletRow = testWallet,
    upstreamCost = '70000.00',
    fetchCostError,
    fulfillRowsAffected = 1,
    refundRowsAffected = 1,
    telegramError,
  } = opts;

  const mockAdapter = opts.adapter ?? {
    purchase: async () => ({
      credential: 'KEY-AAA',
      externalOrderId: 'ext-123',
      cost: '70000.00',
    }),
    commit: async (_id: string, hint: any) => hint,
  };

  const adapterRegistry = {
    get: (type: string) => {
      if (type === 'CONFIG_POOL') return mockAdapter;
      return undefined;
    },
  } as unknown as AdapterRegistryService;

  const priceFetcher = {
    fetchUpstreamCost: async () => {
      if (fetchCostError) throw fetchCostError;
      return upstreamCost;
    },
  };

  const ledgerCalls: any[] = [];
  const ledgerService = {
    credit: async (
      walletId: string,
      amount: string,
      type: any,
      idempotencyKey: string,
      referenceId: string,
      _tx: any,
    ) => {
      ledgerCalls.push({ walletId, amount, type, idempotencyKey, referenceId });
      return { id: 'tx-refund' };
    },
  };

  const telegramCalls: { type: 'confirmation' | 'refund'; args: any[] }[] = [];
  const telegramBot = {
    sendOrderConfirmation: async (...args: any[]) => {
      if (telegramError) throw telegramError;
      telegramCalls.push({ type: 'confirmation', args });
    },
    sendRefundNotice: async (...args: any[]) => {
      if (telegramError) throw telegramError;
      telegramCalls.push({ type: 'refund', args });
    },
  };

  const auditInserts: any[] = [];
  const orderUpdates: any[] = [];

  const originalSelect = db.select;
  const originalTransaction = db.transaction;

  // DB Mock
  (db as any).select = () => ({
    from: (table: any) => ({
      where: () => {
        if (table === orders) {
          return Promise.resolve(orderRow ? [orderRow] : []);
        }
        if (table === products) {
          return Promise.resolve(productRow ? [productRow] : []);
        }
        if (table === supplierSources) {
          return Promise.resolve(supplierRow ? [supplierRow] : []);
        }
        if (table === users) {
          return Promise.resolve(userRow ? [userRow] : []);
        }
        if (table === wallets) {
          return Promise.resolve(walletRow ? [walletRow] : []);
        }
        return Promise.resolve([]);
      },
    }),
  });

  (db as any).transaction = async (cb: any) => {
    const mockTx = {
      select: () => ({
        from: (table: any) => ({
          where: () => ({
            for: async () => {
              if (table === wallets) return walletRow ? [walletRow] : [];
              return [];
            },
          }),
        }),
      }),
      update: (table: any) => ({
        set: (payload: any) => ({
          where: () => ({
            returning: async () => {
              if (table === orders) {
                orderUpdates.push(payload);
                if (payload.status === OrderStatus.FULFILLED) {
                  return fulfillRowsAffected > 0
                    ? [{ ...testOrder, ...payload }]
                    : [];
                }
                if (payload.status === OrderStatus.REFUNDED) {
                  return refundRowsAffected > 0
                    ? [{ ...testOrder, ...payload }]
                    : [];
                }
                if (payload.deliveredCredential) {
                  return [{ ...testOrder, ...payload }];
                }
              }
              return [];
            },
          }),
        }),
      }),
      insert: (table: any) => ({
        values: async (vals: any) => {
          if (table === supplierOrders) {
            auditInserts.push(vals);
          }
        },
      }),
    };
    return cb(mockTx);
  };

  const service = new SourcingExecutorService(
    adapterRegistry,
    priceFetcher as any,
    ledgerService as any,
    telegramBot as any,
  );

  const cleanup = () => {
    (db as any).select = originalSelect;
    (db as any).transaction = originalTransaction;
  };

  return {
    service,
    cleanup,
    ledgerCalls,
    telegramCalls,
    auditInserts,
    orderUpdates,
  };
}

test('[P2] SourcingExecutor: silently discards job if order is missing', async () => {
  const { service, cleanup, ledgerCalls } = createHarness({
    orderRow: null,
  });
  try {
    await service.execute({
      data: { orderId: 'order-missing', productId: 'prod-1', supplierSourceId: 'sup-1' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any);
    assert.strictEqual(ledgerCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('[P2] SourcingExecutor: silently discards job if order is not in SOURCING status', async () => {
  const { service, cleanup, ledgerCalls } = createHarness({
    orderRow: { ...testOrder, status: OrderStatus.FULFILLED },
  });
  try {
    await service.execute({
      data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any);
    assert.strictEqual(ledgerCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('[P1] SourcingExecutor: terminal failure when product is missing -> refunds order', async () => {
  const { service, cleanup, ledgerCalls, auditInserts } = createHarness({
    productRow: null,
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-missing', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'PRODUCT_MISSING');
        return true;
      },
    );

    assert.strictEqual(ledgerCalls.length, 1);
    assert.strictEqual(ledgerCalls[0].type, LedgerType.PURCHASE_REFUND);
    assert.strictEqual(ledgerCalls[0].amount, testOrder.price);

    assert.strictEqual(auditInserts.length, 1);
    assert.strictEqual(auditInserts[0].status, SupplierOrderStatus.FAILED);
    assert.strictEqual(auditInserts[0].supplierSourceId, null);
    assert.strictEqual(auditInserts[0].errorMessage, 'PRODUCT_MISSING');
  } finally {
    cleanup();
  }
});

test('[P1] SourcingExecutor: terminal failure when supplier is missing -> audit row has supplierSourceId null', async () => {
  const { service, cleanup, ledgerCalls, auditInserts, telegramCalls } = createHarness({
    supplierRow: null,
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-deleted' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'SUPPLIER_INVALID');
        return true;
      },
    );

    assert.strictEqual(ledgerCalls.length, 1);
    assert.strictEqual(auditInserts.length, 1);
    assert.strictEqual(auditInserts[0].supplierSourceId, null);
    assert.strictEqual(auditInserts[0].status, SupplierOrderStatus.FAILED);
    assert.strictEqual(telegramCalls.length, 1);
    assert.strictEqual(telegramCalls[0].type, 'refund');
  } finally {
    cleanup();
  }
});

test('[P1] SourcingExecutor: terminal failure when supplier is inactive', async () => {
  const { service, cleanup, auditInserts } = createHarness({
    supplierRow: { ...testSupplier, isActive: false },
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'SUPPLIER_INVALID');
        return true;
      },
    );
    assert.strictEqual(auditInserts[0].errorMessage, 'SUPPLIER_INVALID');
  } finally {
    cleanup();
  }
});

test('[P1] SourcingExecutor: terminal failure when adapter is missing for supplier type', async () => {
  const { service, cleanup, auditInserts } = createHarness({
    supplierRow: { ...testSupplier, type: 'UNKNOWN_SCRAPER' },
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'ADAPTER_MISSING:UNKNOWN_SCRAPER');
        return true;
      },
    );
    assert.strictEqual(auditInserts[0].errorMessage, 'ADAPTER_MISSING:UNKNOWN_SCRAPER');
  } finally {
    cleanup();
  }
});

test('[P0] SourcingExecutor: terminal failure on margin breach (upstreamCost > maxUpstreamCost)', async () => {
  const { service, cleanup, auditInserts } = createHarness({
    upstreamCost: '95000.00', // max is 80000.00
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'MARGIN_BREACH');
        return true;
      },
    );
    assert.strictEqual(auditInserts[0].errorMessage, 'MARGIN_BREACH');
  } finally {
    cleanup();
  }
});

test('[P0] SourcingExecutor: terminal failure on margin breach (upstreamCost > order.price)', async () => {
  const { service, cleanup, auditInserts } = createHarness({
    productRow: { ...testProduct, maxUpstreamCost: null },
    upstreamCost: '110000.00', // order price is 100000.00
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'MARGIN_BREACH');
        return true;
      },
    );
    assert.strictEqual(auditInserts[0].errorMessage, 'MARGIN_BREACH');
  } finally {
    cleanup();
  }
});

test('[P0] SourcingExecutor: retryable error rethrows without refund when attempts remain', async () => {
  const { service, cleanup, ledgerCalls, auditInserts } = createHarness({
    adapter: {
      purchase: async () => {
        throw new SupplierRetryableError('Network 503');
      },
    },
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof SupplierRetryableError);
        assert.strictEqual(err.message, 'Network 503');
        return true;
      },
    );

    // No refund on retryable error when attempts remain
    assert.strictEqual(ledgerCalls.length, 0);
    assert.strictEqual(auditInserts.length, 0);
  } finally {
    cleanup();
  }
});

test('[P0] SourcingExecutor: retry exhaustion on final attempt triggers refund path', async () => {
  const { service, cleanup, ledgerCalls, auditInserts } = createHarness({
    adapter: {
      purchase: async () => {
        throw new SupplierRetryableError('Network 503');
      },
    },
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 2, // 3rd attempt (last attempt of 3)
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert(err.message.startsWith('RETRY_EXHAUSTED:Network 503'));
        return true;
      },
    );

    assert.strictEqual(ledgerCalls.length, 1);
    assert.strictEqual(auditInserts.length, 1);
    assert.strictEqual(auditInserts[0].status, SupplierOrderStatus.FAILED);
  } finally {
    cleanup();
  }
});

test('[P0] SourcingExecutor: terminal error from adapter immediately refunds and marks unrecoverable', async () => {
  const { service, cleanup, ledgerCalls, auditInserts } = createHarness({
    adapter: {
      purchase: async () => {
        throw new SupplierTerminalError('CREDENTIAL_POOL_EMPTY');
      },
    },
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'CREDENTIAL_POOL_EMPTY');
        return true;
      },
    );

    assert.strictEqual(ledgerCalls.length, 1);
    assert.strictEqual(auditInserts[0].errorMessage, 'CREDENTIAL_POOL_EMPTY');
  } finally {
    cleanup();
  }
});

test('[P0] SourcingExecutor: success path fulfills order, writes audit, and sends confirmation', async () => {
  let commitCalled = false;
  const { service, cleanup, ledgerCalls, auditInserts, orderUpdates, telegramCalls } =
    createHarness({
      adapter: {
        purchase: async () => ({
          credential: 'HINT-KEY',
          externalOrderId: 'ext-pool',
        }),
        commit: async (_id: string, _hint: any) => {
          commitCalled = true;
          return {
            credential: 'AUTHORITATIVE-KEY-123',
            externalOrderId: 'ext-pool',
          };
        },
      },
    });
  try {
    await service.execute({
      data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any);

    assert.strictEqual(commitCalled, true);
    assert.strictEqual(ledgerCalls.length, 0); // No refund!

    assert.strictEqual(orderUpdates.length, 2);
    assert.strictEqual(orderUpdates[0].status, OrderStatus.FULFILLED);
    assert.strictEqual(orderUpdates[1].deliveredCredential, 'AUTHORITATIVE-KEY-123');

    assert.strictEqual(auditInserts.length, 1);
    assert.strictEqual(auditInserts[0].status, SupplierOrderStatus.SUCCESS);
    assert.strictEqual(auditInserts[0].externalOrderId, 'ext-pool');
    assert.strictEqual(auditInserts[0].cost, '70000.00');

    assert.strictEqual(telegramCalls.length, 1);
    assert.strictEqual(telegramCalls[0].type, 'confirmation');
  } finally {
    cleanup();
  }
});

test('[P1] SourcingExecutor: terminal failure when upstream price fetch fails -> COST_UNAVAILABLE refund', async () => {
  const { service, cleanup, ledgerCalls, auditInserts } = createHarness({
    fetchCostError: new Error('Price provider timeout'),
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'COST_UNAVAILABLE');
        return true;
      },
    );

    assert.strictEqual(ledgerCalls.length, 1);
    assert.strictEqual(auditInserts[0].errorMessage, 'COST_UNAVAILABLE');
  } finally {
    cleanup();
  }
});

test('[P1] SourcingExecutor: terminal failure when configCredentials is empty object -> SUPPLIER_INVALID', async () => {
  const { service, cleanup, auditInserts } = createHarness({
    supplierRow: { ...testSupplier, configCredentials: {} },
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'SUPPLIER_INVALID');
        return true;
      },
    );
    assert.strictEqual(auditInserts[0].errorMessage, 'SUPPLIER_INVALID');
  } finally {
    cleanup();
  }
});

test('[P0] SourcingExecutor: purchase timeout throws SupplierRetryableError when attempts remain', async () => {
  const origTimeout = process.env.SOURCING_PURCHASE_TIMEOUT_MS;
  process.env.SOURCING_PURCHASE_TIMEOUT_MS = '20'; // 20ms

  const { service, cleanup, ledgerCalls } = createHarness({
    adapter: {
      purchase: () => new Promise<any>((resolve) => setTimeout(resolve, 200)),
    },
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof SupplierRetryableError);
        assert(err.message.includes('Purchase timed out'));
        return true;
      },
    );
    assert.strictEqual(ledgerCalls.length, 0);
  } finally {
    if (origTimeout !== undefined)
      process.env.SOURCING_PURCHASE_TIMEOUT_MS = origTimeout;
    else delete process.env.SOURCING_PURCHASE_TIMEOUT_MS;
    cleanup();
  }
});

test('[P0] SourcingExecutor: invalid output credential after commit causes rollback and refund', async () => {
  const { service, cleanup, ledgerCalls, auditInserts } = createHarness({
    adapter: {
      purchase: async () => ({ credential: 'HINT' }),
      commit: async () => ({
        credential: '   ', // whitespace only -> invalid
      }),
    },
  });
  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'INVALID_OUTPUT');
        return true;
      },
    );

    assert.strictEqual(ledgerCalls.length, 1);
    assert.strictEqual(auditInserts.length, 1);
    assert.strictEqual(auditInserts[0].status, SupplierOrderStatus.FAILED);
    assert.strictEqual(auditInserts[0].errorMessage, 'INVALID_OUTPUT');
  } finally {
    cleanup();
  }
});

test('[P1] SourcingExecutor: race lost on fulfill recovers credential into inventory and audits recovery', async () => {
  const { service, cleanup, auditInserts, telegramCalls } = createHarness({
    fulfillRowsAffected: 0, // 0 rows updated
  });
  try {
    await service.execute({
      data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any);

    // Credential is recovered to inventory and audited; customer is NOT confirmed
    assert.strictEqual(auditInserts.length, 1);
    assert.strictEqual(auditInserts[0].status, SupplierOrderStatus.SUCCESS);
    assert.deepStrictEqual(auditInserts[0].rawPayload, {
      note: 'ORPHANED_CREDENTIAL_RECOVERED_TO_INVENTORY_AFTER_TIMEOUT',
    });
    assert.strictEqual(telegramCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('[P1] SourcingExecutor: race lost on refund does not credit wallet or insert audit', async () => {
  const { service, cleanup, ledgerCalls, auditInserts, telegramCalls } = createHarness({
    supplierRow: null,
    refundRowsAffected: 0, // 0 rows updated on refund
  });
  try {
    await service.execute({
      data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any);

    assert.strictEqual(ledgerCalls.length, 0);
    assert.strictEqual(auditInserts.length, 0);
    assert.strictEqual(telegramCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('[P1] SourcingExecutor: telegram notification failure during fulfillment does not fail fulfillment or audit', async () => {
  const { service, cleanup, orderUpdates, auditInserts } = createHarness({
    telegramError: new Error('Telegram Bot API network timeout'),
  });

  try {
    await service.execute({
      data: { orderId: 'order-1', productId: 'prod-1', supplierSourceId: 'sup-1' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any);

    assert.strictEqual(orderUpdates.length, 2);
    assert.strictEqual(orderUpdates[0].status, OrderStatus.FULFILLED);
    assert.strictEqual(auditInserts.length, 1);
    assert.strictEqual(auditInserts[0].status, SupplierOrderStatus.SUCCESS);
  } finally {
    cleanup();
  }
});

test('[P1] SourcingExecutor: telegram refund notification failure does not suppress terminal refund error', async () => {
  const { service, cleanup, ledgerCalls, auditInserts } = createHarness({
    productRow: null,
    telegramError: new Error('Telegram Bot API 403 Blocked'),
  });

  try {
    await assert.rejects(
      async () => {
        await service.execute({
          data: { orderId: 'order-1', productId: 'prod-missing', supplierSourceId: 'sup-1' },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any);
      },
      (err: any) => {
        assert(err instanceof UnrecoverableError);
        assert.strictEqual(err.message, 'PRODUCT_MISSING');
        return true;
      },
    );

    // Ledger refund and audit insert were completed before telegram warning
    assert.strictEqual(ledgerCalls.length, 1);
    assert.strictEqual(auditInserts.length, 1);
    assert.strictEqual(auditInserts[0].status, SupplierOrderStatus.FAILED);
  } finally {
    cleanup();
  }
});
