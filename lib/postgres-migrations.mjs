import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const migrationDirectory = fileURLToPath(new URL('../migrations/postgres/', import.meta.url));
export async function migratePostgres(pool, directory = migrationDirectory) {
  const files = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('No PostgreSQL migrations found');
  const migrations = await Promise.all(files.map(async id => {
    const sql = await readFile(join(directory, id), 'utf8');
    return { id, sql, checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex') };
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Transaction-scoped locking makes simultaneous migration commands safe.
    await client.query('SELECT pg_advisory_xact_lock(4317001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT id,checksum FROM schema_migrations ORDER BY id');
    for (const applied of rows) {
      const source = migrations.find(m => m.id === applied.id);
      if (!source || source.checksum !== applied.checksum) throw new Error(`Migration history mismatch: ${applied.id}`);
    }
    const appliedIds = new Set(rows.map(r => r.id));
    const pending = migrations.filter(m => !appliedIds.has(m.id));
    if (pending.some(m => rows.some(row => row.id > m.id))) throw new Error('New migrations must follow the applied migration history');
    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (id,checksum) VALUES ($1,$2)', [migration.id, migration.checksum]);
    }
    await client.query('COMMIT');
    return pending.map(m => m.id);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
