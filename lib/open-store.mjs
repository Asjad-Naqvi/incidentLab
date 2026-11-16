import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { projectRoot } from './config.mjs';

export async function openStore(env = process.env) {
  if (env.DATABASE_URL) {
    const { createPostgresStore, postgresPool } = await import('./postgres-store.mjs');
    const store = createPostgresStore(postgresPool(env.DATABASE_URL));
    try { await store.ping(); await store.isFixed(); return store; }
    catch { await store.close(); throw new Error('PostgreSQL unavailable or schema missing. Check DATABASE_URL and run npm.cmd run db:migrate.'); }
  }
  mkdirSync(join(projectRoot, 'data'), { recursive: true });
  const { createStore } = await import('./store.mjs');
  return createStore(env.SQLITE_PATH || join(projectRoot, 'data', 'incidentlab.sqlite'));
}
