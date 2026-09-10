import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema';

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5433/9router_ecommerce';

export const pool = new pg.Pool({ connectionString });

pool.on('error', (err) => {
  console.error('[PostgreSQL Pool Error]', err);
});

export const closeDb = async () => {
  await pool.end();
};

export const db = drizzle(pool, { schema });
export type DbClient = typeof db;
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = DbClient | DbTransaction;
export * from './schema';
export { schema, eq, sql };
