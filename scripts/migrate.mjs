import { postgresPool } from '../lib/postgres-store.mjs';
import { migratePostgres } from '../lib/postgres-migrations.mjs';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running PostgreSQL migrations');
const pool = postgresPool(process.env.DATABASE_URL);
try {
  const applied = await migratePostgres(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'PostgreSQL schema is up to date');
} catch { console.error('Migration failed. Check database connectivity and migration history.'); process.exitCode = 1; }
finally { await pool.end(); }
