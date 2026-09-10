import { pgTable, uuid, varchar, bigint, timestamp, check, numeric, boolean, jsonb } from 'drizzle-orm/pg-core';
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
    balanceBefore: numeric('balance_before', { precision: 15, scale: 2 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 15, scale: 2 }).notNull(),
    referenceId: varchar('reference_id', { length: 100 }),
    idempotencyKey: varchar('idempotency_key', { length: 100 }).unique(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  }
);
