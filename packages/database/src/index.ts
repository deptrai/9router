import { drizzle } from 'drizzle-orm/node-postgres';
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
export * from './schema';
export { schema };
