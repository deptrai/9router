import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5433/9router_ecommerce';

const pool = new pg.Pool({ connectionString });

export const db = drizzle(pool, { schema });
export * from './schema';
export { schema };
