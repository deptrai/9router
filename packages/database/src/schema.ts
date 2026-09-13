import { pgTable, uuid, varchar, bigint, timestamp, check, index, numeric, boolean, jsonb, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull().unique(),
  username: varchar('username', { length: 255 }),
  firstName: varchar('first_name', { length: 255 }),
  lastName: varchar('last_name', { length: 255 }),
  languageCode: varchar('language_code', { length: 35 }),
  isPremium: boolean('is_premium').notNull().default(false),
  role: varchar('role', { length: 50 }).notNull().default('CUSTOMER'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    balance: numeric('balance', { precision: 15, scale: 2 }).notNull().default('0.00'),
    heldBalance: numeric('held_balance', { precision: 15, scale: 2 }).notNull().default('0.00'),
    currency: varchar('currency', { length: 10 }).notNull().default('VND'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('balance_non_negative', sql`${table.balance} >= 0`),
    check('held_balance_non_negative', sql`${table.heldBalance} >= 0`),
  ]
);

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 30 }).notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 10 }).notNull().default('VND'),
    balanceBefore: numeric('balance_before', { precision: 15, scale: 2 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 15, scale: 2 }).notNull(),
    referenceId: varchar('reference_id', { length: 100 }),
    idempotencyKey: varchar('idempotency_key', { length: 100 }).unique(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ledger_wallet_id_idx').on(table.walletId),
    index('ledger_reference_id_idx').on(table.referenceId),
    index('ledger_created_at_idx').on(table.createdAt),
  ]
);

export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    gateway: varchar('gateway', { length: 20 }).notNull().default('VIETQR'),
    externalTransactionId: varchar('external_transaction_id', { length: 255 }).unique(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('PENDING'),
    transferContent: varchar('transfer_content', { length: 255 }).notNull().unique(),
    bankName: varchar('bank_name', { length: 100 }),
    bankBin: varchar('bank_bin', { length: 20 }),
    bankAccount: varchar('bank_account', { length: 50 }),
    qrPayload: text('qr_payload'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  }
);

export const supplierSources = pgTable(
  'supplier_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    type: varchar('type', { length: 50 }).notNull().default('WEB_SCRAPER'),
    targetUrl: varchar('target_url', { length: 512 }),
    configCredentials: jsonb('config_credentials'),
    markupPercentage: numeric('markup_percentage', { precision: 8, scale: 2 }).notNull().default('0.00'),
    markupFixedVnd: numeric('markup_fixed_vnd', { precision: 15, scale: 2 }).notNull().default('0.00'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('supplier_markup_non_negative', sql`${table.markupPercentage} >= 0`),
    check('supplier_markup_fixed_non_negative', sql`${table.markupFixedVnd} >= 0`),
  ]
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 255 }).notNull().unique(),
    description: text('description'),
    category: varchar('category', { length: 100 }),
    price: numeric('price', { precision: 15, scale: 2 }).notNull(),
    imageUrl: varchar('image_url', { length: 512 }),
    isActive: boolean('is_active').notNull().default(true),
    sourcingMode: varchar('sourcing_mode', { length: 20 }).notNull().default('IN_HOUSE'),
    supplierSourceId: uuid('supplier_source_id').references(() => supplierSources.id, {
      onDelete: 'set null',
    }),
    supplierProductUrl: varchar('supplier_product_url', { length: 512 }),
    upstreamCost: numeric('upstream_cost', { precision: 15, scale: 2 }),
    maxUpstreamCost: numeric('max_upstream_cost', { precision: 15, scale: 2 }),
    costSyncedAt: timestamp('cost_synced_at', { withTimezone: true }),
    autoPricing: boolean('auto_pricing').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('products_supplier_source_id_idx').on(table.supplierSourceId),
    index('products_active_category_idx').on(table.isActive, table.category),
    check('products_price_non_negative', sql`${table.price} >= 0`),
    check('products_max_upstream_cost_valid', sql`${table.maxUpstreamCost} IS NULL OR ${table.maxUpstreamCost} > 0`),
    check('products_upstream_cost_valid', sql`${table.upstreamCost} IS NULL OR ${table.upstreamCost} >= 0`),
    check('products_sourcing_mode_valid', sql`${table.sourcingMode} IN ('IN_HOUSE', 'EXTERNAL', 'HYBRID')`),
  ]
);

export const adminAlerts = pgTable(
  'admin_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: varchar('type', { length: 50 }).notNull(),
    severity: varchar('severity', { length: 20 }).notNull().default('WARN'),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    supplierSourceId: uuid('supplier_source_id').references(() => supplierSources.id, { onDelete: 'set null' }),
    message: text('message').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('admin_alerts_type_idx').on(table.type),
    index('admin_alerts_created_at_idx').on(table.createdAt),
    check('admin_alerts_type_valid', sql`${table.type} IN ('PRICE_THRESHOLD_EXCEEDED', 'PRICE_SYNC_FAILED')`),
  ]
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    price: numeric('price', { precision: 15, scale: 2 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('PENDING'),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).unique(),
    deliveredCredential: text('delivered_credential'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
  },
  (table) => [
    index('orders_user_id_idx').on(table.userId),
    index('orders_product_id_idx').on(table.productId),
    index('orders_status_created_at_idx').on(table.status, table.createdAt),
    check('orders_status_valid', sql`${table.status} IN ('PENDING', 'PAID', 'SOURCING', 'FULFILLED', 'REFUNDED', 'FAILED')`),
  ]
);

export const supplierOrders = pgTable(
  'supplier_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    supplierSourceId: uuid('supplier_source_id').references(() => supplierSources.id, { onDelete: 'set null' }),
    externalOrderId: varchar('external_order_id', { length: 255 }),
    cost: numeric('cost', { precision: 18, scale: 2 }),
    status: varchar('status', { length: 32 }).notNull().default('PENDING'),
    rawPayload: jsonb('raw_payload'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('supplier_orders_order_idx').on(table.orderId),
    index('supplier_orders_supplier_idx').on(table.supplierSourceId),
    index('supplier_orders_status_idx').on(table.status),
    index('supplier_orders_created_at_idx').on(table.createdAt),
    check('supplier_orders_status_valid', sql`${table.status} IN ('PENDING', 'SUCCESS', 'FAILED')`),
    check('supplier_orders_cost_non_negative', sql`${table.cost} IS NULL OR ${table.cost} >= 0`),
  ]
);

export const productInventory = pgTable(
  'product_inventory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    credentialData: text('credential_data').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('AVAILABLE'),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    soldAt: timestamp('sold_at', { withTimezone: true }),
  },
  (table) => [
    index('product_inventory_product_id_idx').on(table.productId),
    index('product_inventory_prod_status_idx').on(table.productId, table.status),
    check('product_inventory_status_valid', sql`${table.status} IN ('AVAILABLE', 'RESERVED', 'SOLD', 'DEFECTIVE')`),
  ]
);
