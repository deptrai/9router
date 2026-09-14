import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index';

export async function runMigrations(): Promise<void> {
  console.log('[DB Migration] Applying pending database migrations...');
  const migrationsFolder = path.resolve(__dirname, '../drizzle');
  await migrate(db, { migrationsFolder });
  console.log('[DB Migration] Migrations applied successfully');
}

if (require.main === module) {
  runMigrations()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[DB Migration Failed]', err);
      await pool.end();
      process.exit(1);
    });
}
