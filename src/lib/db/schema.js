// Latest schema version — bumped when a migration is added in ./migrations/
export const SCHEMA_VERSION = 10;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  plans: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      displayName: "TEXT",
      rpm: "INTEGER DEFAULT 0",
      quota5h: "INTEGER DEFAULT 0",
      quotaWeekly: "INTEGER DEFAULT 0",
      priceCredits: "REAL DEFAULT 0",
      durationDays: "INTEGER DEFAULT 30",
      perModelLimits: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      sortOrder: "INTEGER DEFAULT 0",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_plans_name ON plans(name)",
    ],
  },
  users: {
    columns: {
      id: "TEXT PRIMARY KEY",
      email: "TEXT UNIQUE NOT NULL",
      passwordHash: "TEXT NOT NULL",
      displayName: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      isEmailVerified: "INTEGER DEFAULT 0",
      creditsBalance: "REAL DEFAULT 0",
      planId: "TEXT",
      planExpiresAt: "TEXT",
      allowCreditOverflow: "INTEGER DEFAULT 0",
      googleSub: "TEXT",
      telegramId: "TEXT",
      authProviders: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_googleSub ON users(googleSub) WHERE googleSub IS NOT NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegramId ON users(telegramId) WHERE telegramId IS NOT NULL",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      userId: "TEXT",
      description: "TEXT",
      lastUsedAt: "TEXT",
      creditLimit: "REAL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)",
      "CREATE INDEX IF NOT EXISTS idx_ak_user ON apiKeys(userId)",
    ],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_apikey_ts ON usageHistory(apiKey, timestamp)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_rd_apikey ON requestDetails(apiKey)",
    ],
  },
  payments: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      gatewayPaymentId: "TEXT UNIQUE",
      gatewayInvoiceId: "TEXT",
      txHash: "TEXT",
      network: "TEXT NOT NULL",
      coin: "TEXT NOT NULL",
      amountExpected: "REAL NOT NULL",
      amountReceived: "REAL",
      creditsAwarded: "REAL",
      bonusPercent: "INTEGER DEFAULT 0",
      status: "TEXT NOT NULL DEFAULT 'pending'",
      payAddress: "TEXT",
      paymentUrl: "TEXT",
      confirmations: "INTEGER DEFAULT 0",
      expiresAt: "TEXT",
      settledAt: "TEXT",
      errorMessage: "TEXT",
      provider: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway ON payments(gatewayPaymentId)",
      "CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(userId)",
      "CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)",
    ],
  },
  giftCodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      code: "TEXT UNIQUE NOT NULL",
      creditsAmount: "REAL NOT NULL",
      maxRedemptions: "INTEGER",
      redeemedCount: "INTEGER DEFAULT 0",
      expiresAt: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      note: "TEXT",
      createdBy: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_giftcodes_code ON giftCodes(code)",
      "CREATE INDEX IF NOT EXISTS idx_giftcodes_active ON giftCodes(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_giftcodes_expires ON giftCodes(expiresAt)",
    ],
  },
  giftCodeRedemptions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      giftCodeId: "TEXT NOT NULL",
      code: "TEXT NOT NULL",
      userId: "TEXT NOT NULL",
      creditsAwarded: "REAL NOT NULL",
      redeemedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_gcr_user ON giftCodeRedemptions(userId, redeemedAt)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_gcr_unique ON giftCodeRedemptions(giftCodeId, userId)",
    ],
  },
  // Story 2.25: Telegram Store product catalog
  products: {
    columns: {
      id: "TEXT PRIMARY KEY",
      kind: "TEXT NOT NULL",            // plan|credential|account|service|api_package
      name: "TEXT NOT NULL",
      description: "TEXT",
      priceCredits: "REAL NOT NULL",
      deliveryMode: "TEXT NOT NULL",    // instant|admin_fulfill|user_self_connect
      targetType: "TEXT",               // 9router_plan|... (null cho non-plan)
      targetId: "TEXT",                 // planId nếu targetType=9router_plan
      stock: "INTEGER",                 // null = unlimited
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_products_active ON products(isActive)",
    ],
  },

  // BP-1: immutable — NO updatedAt column. Append-only. Corrections via reversal rows.
  // BP-6: amount/balanceAfter kept as REAL (float) — known-limitation, see Dev Notes 2.13.
  creditTransactions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      type: "TEXT NOT NULL",
      bucket: "TEXT NOT NULL DEFAULT 'standard'",
      amount: "REAL NOT NULL",
      multiplier: "REAL DEFAULT 1",
      expiresAt: "TEXT",
      refId: "TEXT",
      idempotencyKey: "TEXT",
      balanceAfter: "REAL",
      note: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ct_user_ts ON creditTransactions(userId, createdAt)",
      "CREATE INDEX IF NOT EXISTS idx_ct_user_bucket ON creditTransactions(userId, bucket)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ct_idempotency ON creditTransactions(idempotencyKey)",
    ],
  },

  // Story 2.26: Telegram Store orders. State machine: pending|paid|fulfilled|cancelled|failed|refunded.
  // For a credit-paid store purchase, order is created already `paid` (credit debited atomically in
  // same txn) then transitioned to `fulfilled` for instant delivery, or kept `paid` awaiting admin_fulfill.
  orders: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      status: "TEXT NOT NULL DEFAULT 'pending'", // pending|paid|fulfilled|cancelled|failed|refunded
      source: "TEXT NOT NULL DEFAULT 'telegram'", // telegram|web|...
      totalCredits: "REAL NOT NULL DEFAULT 0",
      deliveryMode: "TEXT",                       // snapshot from product at purchase time
      ledgerTxnId: "TEXT",                        // creditTransactions.id of the store_purchase debit
      idempotencyKey: "TEXT",                     // client/callback dedup key
      note: "TEXT",
      fulfilledAt: "TEXT",                        // set when order reaches fulfilled status
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_orders_user_ts ON orders(userId, createdAt)",
      "CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency ON orders(idempotencyKey)",
    ],
  },

  // Order line items — snapshot product fields at purchase time (price/name immutable post-sale).
  orderItems: {
    columns: {
      id: "TEXT PRIMARY KEY",
      orderId: "TEXT NOT NULL",
      productId: "TEXT NOT NULL",
      productName: "TEXT NOT NULL",   // snapshot
      kind: "TEXT NOT NULL",          // snapshot
      deliveryMode: "TEXT NOT NULL",  // snapshot
      targetType: "TEXT",             // snapshot
      targetId: "TEXT",               // snapshot
      unitCredits: "REAL NOT NULL",   // snapshot price
      quantity: "INTEGER NOT NULL DEFAULT 1",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_orderitems_order ON orderItems(orderId)",
    ],
  },

  // Story 2.27: Per-unit credential inventory. One row = one deliverable credential item.
  // Status flow: available → delivered (storeCheckout txn) | revoked (admin).
  productCredentials: {
    columns: {
      id: "TEXT PRIMARY KEY",
      productId: "TEXT NOT NULL",
      payload: "TEXT NOT NULL",                    // JSON or plain string: the actual credential
      status: "TEXT NOT NULL DEFAULT 'available'", // available|reserved|delivered|revoked
      orderId: "TEXT",                             // set when reserved (→ orders.id)
      orderItemId: "TEXT",                         // set when reserved (→ orderItems.id)
      reservedAt: "TEXT",                          // set when status→reserved (inside txn)
      deliveredAt: "TEXT",                         // set when status→delivered (post-txn)
      note: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_product_status ON productCredentials(productId, status)",
      "CREATE INDEX IF NOT EXISTS idx_pc_order ON productCredentials(orderId)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
